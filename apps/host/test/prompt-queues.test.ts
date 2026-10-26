import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskDetail } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import { PromptQueues, type QueueActor, type QueueOptions } from '../src/prompt-queues.ts'

const roots: string[] = []
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true })
})
const actor: QueueActor = { deviceId: 'device', listener: 'unix', dataScope: 'all' }
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'latch-queue-'))
  roots.push(dataDir)
  const detail: TaskDetail = {
    summary: { id: 'task', title: 'Queue', status: 'running', updatedAt: '', runId: 'run-1' },
    messages: [],
    approvals: [],
    liveText: '',
    cursor: 0,
  }
  const options: QueueOptions = {
    dataDir,
    detail: async () => structuredClone(detail),
    check: vi.fn(async () => {}),
    beforeEnqueue: vi.fn(async () => {}),
    changed: vi.fn(),
    send: vi.fn(async () => {
      detail.summary.status = 'running'
      detail.summary.runId = randomUUID()
      delete detail.summary.runOutcome
    }),
  }
  return { dataDir, detail, options, queue: await PromptQueues.open(options) }
}
const input = (prompt = 'Next') => ({ prompt, requestId: randomUUID() })
const completed = (detail: TaskDetail) => {
  detail.summary.status = 'idle'
  detail.summary.runOutcome = 'completed'
}

describe('persistent Host prompt queues', () => {
  it('admits at most five, deduplicates exact submissions, refuses changed retries and keeps authority private', async () => {
    const { queue, dataDir } = await fixture()
    const body = input()
    expect(await queue.submit(actor, 'task', body)).toEqual(await queue.submit(actor, 'task', body))
    await expect(queue.submit(actor, 'task', { ...body, prompt: 'Different' })).rejects.toMatchObject({ code: 'request-conflict' })
    for (let n = 0; n < 4; n++) await queue.submit(actor, 'task', input())
    await expect(queue.submit(actor, 'task', input())).rejects.toMatchObject({ code: 'queue-full' })
    expect(queue.view('task')).toHaveLength(5)
    expect(JSON.stringify(queue.view('task'))).not.toContain('deviceId')
    expect((await stat(join(dataDir, 'queues.json'))).mode & 0o777).toBe(0o600)
  })
  it('drains FIFO one successful run at a time, passing the original request identity and queue timestamp', async () => {
    const { queue, detail, options } = await fixture()
    const first = input('First'),
      second = input('Second')
    await queue.submit(actor, 'task', first)
    await queue.submit(actor, 'task', second)
    const queuedAt = queue.view('task')[0]!.queuedAt
    completed(detail)
    await queue.changed('task')
    expect(options.send).toHaveBeenCalledTimes(1)
    expect(options.send).toHaveBeenLastCalledWith(
      expect.objectContaining(actor),
      'task',
      expect.objectContaining({ text: 'First', requestId: first.requestId, queuedAt }),
    )
    expect(queue.view('task').map(item => item.text)).toEqual(['Second'])
    completed(detail)
    await queue.changed('task')
    expect(options.send).toHaveBeenCalledTimes(2)
    expect(queue.view('task')).toEqual([])
    expect(await queue.submit(actor, 'task', first)).toEqual({ accepted: true })
    expect(options.send).toHaveBeenCalledTimes(2)
  })
  it.each(['failed', 'cancelled', 'interrupted'] as const)(
    'parks after %s and resumes only after a person sends the first item',
    async status => {
      const { queue, detail, options } = await fixture()
      await queue.submit(actor, 'task', input('First'))
      await queue.submit(actor, 'task', input('Second'))
      detail.summary.status = status
      detail.summary.runOutcome = status
      await queue.changed('task')
      expect(queue.view('task').every(item => item.state === 'parked')).toBe(true)
      completed(detail)
      await queue.changed('task')
      expect(options.send).not.toHaveBeenCalled()
      await queue.send('task', queue.view('task')[0]!.id)
      expect(options.send).toHaveBeenCalledTimes(1)
      expect(queue.view('task')[0]!.state).toBe('waiting')
    },
  )
  it('does not infer completion from idle, a changed run identity or pending approvals', async () => {
    for (const reason of ['unknown', 'changed', 'approval']) {
      const { queue, detail, options } = await fixture()
      await queue.submit(actor, 'task', input())
      completed(detail)
      if (reason === 'unknown') delete detail.summary.runOutcome
      if (reason === 'changed') detail.summary.runId = 'another-run'
      if (reason === 'approval') detail.approvals = [{} as TaskDetail['approvals'][number]]
      await queue.changed('task')
      expect(options.send).not.toHaveBeenCalled()
      expect(queue.view('task')[0]!.state).toBe('parked')
    }
  })
  it('parks at restart, keeps removals idempotent, and never resurrects an old request', async () => {
    const { queue, dataDir, options } = await fixture()
    const body = input()
    await queue.submit(actor, 'task', body)
    const reopened = await PromptQueues.open(options)
    const item = reopened.view('task')[0]!
    expect(item.state).toBe('parked')
    await reopened.remove('task', item.id)
    await reopened.remove('task', item.id)
    expect(await reopened.submit(actor, 'task', body)).toEqual({ accepted: true })
    expect((await PromptQueues.open(options)).view('task')).toEqual([])
    expect(await readFile(join(dataDir, 'queues.json'), 'utf8')).not.toContain('"text"')
  })
  it('audits before enqueue and rechecks original authority again when a successful run ends', async () => {
    const { queue, detail, options } = await fixture()
    vi.mocked(options.beforeEnqueue).mockRejectedValueOnce(new AppError(503, 'audit-unavailable', 'Unavailable'))
    await expect(queue.submit(actor, 'task', input())).rejects.toMatchObject({ code: 'audit-unavailable' })
    expect(queue.view('task')).toEqual([])
    await queue.submit(actor, 'task', input())
    vi.mocked(options.check).mockRejectedValue(new AppError(403, 'scope-required', 'No run'))
    completed(detail)
    await queue.changed('task')
    expect(options.send).not.toHaveBeenCalled()
    expect(queue.view('task')[0]!.state).toBe('dropped')
    await queue.remove('task', queue.view('task')[0]!.id)
    expect(queue.view('task')).toEqual([])
  })
  it('keeps a native lease private and parks an expired opening without rebinding or losing the prompt', async () => {
    const { queue, detail, options } = await fixture()
    const native = { ...actor, nativeWindowHash: 'a'.repeat(64) }
    await queue.submit(native, 'task', input('Native intent'))
    expect(JSON.stringify(queue.view('task'))).not.toContain(native.nativeWindowHash)
    vi.mocked(options.check).mockRejectedValue(new AppError(409, 'queue-paused', 'window expired'))
    completed(detail)
    await queue.changed('task')
    expect(options.send).not.toHaveBeenCalled()
    expect(queue.view('task')[0]).toMatchObject({ text: 'Native intent', state: 'parked' })
    expect(vi.mocked(options.check).mock.calls.at(-1)?.[0].nativeWindowHash).toBe(native.nativeWindowHash)
  })
  it('retains the exact request after unknown delivery and refuses editing until that delivery is resolved', async () => {
    const { queue, detail, options } = await fixture()
    const body = input()
    await queue.submit(actor, 'task', body)
    vi.mocked(options.send).mockRejectedValueOnce(new Error('timeout'))
    completed(detail)
    await queue.changed('task')
    const item = queue.view('task')[0]!
    expect(item).toMatchObject({ state: 'parked', reason: expect.stringContaining('未确认') })
    await expect(queue.edit('task', item.id, 'Changed', actor)).rejects.toMatchObject({ code: 'queue-settled' })
    await queue.send('task', item.id)
    expect(vi.mocked(options.send).mock.calls.map(call => call[2].requestId)).toEqual([body.requestId, body.requestId])
  })
  it('keeps a durable receipt for an idle queue:true request so its retry during the run cannot enqueue it again', async () => {
    const { queue, detail, options } = await fixture()
    completed(detail)
    const body = input()
    expect(await queue.submit(actor, 'task', body)).toEqual({ accepted: true })
    expect(await queue.submit(actor, 'task', body)).toEqual({ accepted: true })
    expect(options.send).toHaveBeenCalledTimes(1)
    expect(queue.view('task')).toEqual([])
  })
  it('rechecks the latest editor without changing the original receipt owner', async () => {
    const { queue, detail, options } = await fixture()
    const original = input('Original intent'),
      editor: QueueActor = { deviceId: 'editor', listener: 'loopback-tcp', dataScope: 'work' }
    const result = await queue.submit(actor, 'task', original)
    if (!('queued' in result)) throw new Error('not queued')
    await queue.edit('task', result.queued.id, 'Changed intent', editor)
    expect(await queue.submit(actor, 'task', original)).toEqual(result)
    vi.mocked(options.check).mockImplementation(async current => {
      if (current.deviceId === editor.deviceId) throw new AppError(403, 'scope-required', 'revoked')
    })
    const reopened = await PromptQueues.open(options)
    completed(detail)
    await reopened.send('task', result.queued.id)
    expect(options.send).not.toHaveBeenCalled()
    expect(reopened.view('task')[0]).toMatchObject({ text: 'Changed intent', state: 'dropped' })
    expect(JSON.stringify(reopened.view('task'))).not.toContain('editor')
  })
  it('retains the original enqueue receipt after editing and a delayed retry beyond a week', async () => {
    const { queue, detail, options } = await fixture()
    const original = input('Before edit')
    const result = await queue.submit(actor, 'task', original)
    if (!('queued' in result)) throw new Error('not queued')
    await queue.edit('task', result.queued.id, 'After edit', actor)
    completed(detail)
    await queue.changed('task')
    options.now = () => Date.now() + 10 * 24 * 60 * 60 * 1000
    completed(detail)
    await queue.submit(actor, 'task', input('Later input'))
    const reopened = await PromptQueues.open(options)
    expect(await reopened.submit(actor, 'task', original)).toEqual({ accepted: true })
    expect(options.send).toHaveBeenCalledTimes(2)
    expect(queue.view('task')).toEqual([])
  })
  it.each([10_000, 100_000])(
    'refuses insertion when %i retained receipts reach a device or Host limit without forgetting identities',
    async count => {
      const { dataDir, options } = await fixture()
      const items = Array.from({ length: count }, (_, index) => ({
        ...actor,
        deviceId: count === 10_000 ? actor.deviceId : `device-${Math.floor(index / 1000)}`,
        id: `queue-${index}`,
        sessionId: 'task',
        requestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        sendRequestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        hash: '0'.repeat(64),
        queuedAt: new Date().toISOString(),
        state: 'sent',
        waitRunId: 'old',
      }))
      await writeFile(join(dataDir, 'queues.json'), JSON.stringify({ version: 1, items }), { mode: 0o600 })
      const reopened = await PromptQueues.open(options)
      await expect(reopened.submit(actor, 'task', input())).rejects.toMatchObject({ code: 'queue-full' })
      expect(options.send).not.toHaveBeenCalled()
      expect((JSON.parse(await readFile(join(dataDir, 'queues.json'), 'utf8')) as { items: unknown[] }).items).toHaveLength(count)
    },
  )
  it('rotates delivery identity on an edit, preserves the initial submission receipt and rejects corrupt files', async () => {
    const { queue, dataDir, detail, options } = await fixture()
    const body = input()
    const result = await queue.submit(actor, 'task', body)
    if (!('queued' in result)) throw new Error('not queued')
    await queue.edit('task', result.queued.id, 'Edited', actor)
    expect(await queue.submit(actor, 'task', body)).toEqual(result)
    completed(detail)
    await queue.changed('task')
    const sent = vi.mocked(options.send).mock.calls[0]![2]
    expect(sent.text).toBe('Edited')
    expect(sent.requestId).not.toBe(body.requestId)
    await writeFile(join(dataDir, 'queues.json'), '{broken', { mode: 0o600 })
    await expect(PromptQueues.open(options)).rejects.toMatchObject({ code: 'queue-corrupt' })
  })
  it('persists only the Host execution hash and fixed model across restart, retaining the original receipt before replanning', async () => {
    const { queue, dataDir, detail, options } = await fixture(),
      body = input(),
      binding = 'b'.repeat(64),
      model = { providerId: 'provider', model: 'fixed' }
    options.prepare = vi.fn(async () => ({ binding, model }))
    const accepted = await queue.submit(actor, 'task', body)
    expect(JSON.stringify(queue.view('task'))).not.toContain(binding)
    const reopened = await PromptQueues.open(options)
    completed(detail)
    await reopened.send('task', reopened.view('task')[0]!.id)
    expect(options.send).toHaveBeenCalledWith(
      expect.anything(),
      'task',
      expect.objectContaining({ binding, model, requestId: body.requestId }),
    )
    vi.mocked(options.prepare).mockRejectedValue(new AppError(409, 'unavailable', 'Unavailable'))
    expect(await reopened.submit(actor, 'task', body)).toEqual({ accepted: true })
    expect(options.prepare).toHaveBeenCalledTimes(1)
    expect(accepted).toHaveProperty('queued')
    const state = JSON.parse(await readFile(join(dataDir, 'queues.json'), 'utf8'))
    state.items[0].binding = 'not-a-host-hash'
    await writeFile(join(dataDir, 'queues.json'), JSON.stringify(state), { mode: 0o600 })
    await expect(PromptQueues.open(options)).rejects.toMatchObject({ code: 'queue-corrupt' })
  })
})
