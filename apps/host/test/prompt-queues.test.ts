import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
    summary: { harnessId: 'standard', id: 'task', title: 'Queue', status: 'running', updatedAt: '', runId: 'run-1' },
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
  it('knows a device’s queued request in any session, so a release of reserved uploads leaves it alone', async () => {
    const { queue } = await fixture()
    const queued = input('Later')
    await queue.submit(actor, 'task', queued)
    expect(queue.knowsRequest('device', queued.requestId)).toBe(true)
    expect(queue.knowsRequest('other-device', queued.requestId)).toBe(false)
    expect(queue.knowsRequest('device', randomUUID())).toBe(false)
  })
  it('refuses an item it could not read back, before anything is written, so the Host still starts', async () => {
    const { queue, dataDir, detail, options } = await fixture()
    await queue.submit(actor, 'task', input('Kept'))
    const before = await readFile(join(dataDir, 'queues.json'), 'utf8')
    await expect(queue.submit(actor, 'task', input('x'.repeat(16_001)))).rejects.toMatchObject({ status: 400, code: 'queue-item-invalid' })
    // The same on a session at rest, where the item would be sent at once.
    detail.summary.status = 'idle'
    const other = await PromptQueues.open({ ...options, dataDir: await mkdtemp(join(tmpdir(), 'latch-queue-')) })
    await expect(other.submit(actor, 'task', input('x'.repeat(16_001)))).rejects.toMatchObject({ code: 'queue-item-invalid' })
    expect(options.beforeEnqueue).toHaveBeenCalledTimes(1)
    expect(await readFile(join(dataDir, 'queues.json'), 'utf8')).toBe(before)
    expect((await PromptQueues.open(options)).view('task').map(item => item.text)).toEqual(['Kept'])
  })
  it('drops the receipt of a message sent at once that the session refused before taking it, so only one way to send it remains', async () => {
    for (const refusal of [
      new AppError(503, 'agent-start-failed', 'Flaky 启动失败'),
      new AppError(503, 'audit-unavailable', '审计记录暂时无法保存'),
      new AppError(409, 'queue-context-changed', '设置已改变'),
    ]) {
      const { queue, detail, options, dataDir } = await fixture()
      detail.summary.status = 'idle'
      vi.mocked(options.send).mockRejectedValueOnce(refusal)
      const body = input('Now')
      await expect(queue.submit(actor, 'task', body)).rejects.toBe(refusal)
      // Nothing visible to retry, nothing on disk: the client's own 重试 is the only way left.
      expect(queue.view('task')).toEqual([])
      expect(queue.knows('task', actor.deviceId, body.requestId)).toBe(false)
      expect(JSON.parse(await readFile(join(dataDir, 'queues.json'), 'utf8')).items).toEqual([])
    }
  })
  it('answers an unlisted 503 and keeps the item when the refused message’s receipt cannot be deleted', async () => {
    const { queue, detail, options, dataDir } = await fixture()
    detail.summary.status = 'idle'
    vi.mocked(options.send).mockImplementationOnce(async () => {
      // The receipt is on disk; the folder turns read-only before it can be deleted.
      await chmod(dataDir, 0o500)
      throw new AppError(503, 'agent-start-failed', 'Flaky 启动失败')
    })
    try {
      await expect(queue.submit(actor, 'task', input('Kept'))).rejects.toMatchObject({ status: 503, code: 'queue-send-unknown' })
    } finally {
      await chmod(dataDir, 0o700)
    }
    // Still there to retry in the queue: the client keeps its requestId rather than sending the text a second way.
    expect(queue.view('task').map(item => item.text)).toEqual(['Kept'])
    expect(JSON.parse(await readFile(join(dataDir, 'queues.json'), 'utf8')).items.map((item: { text?: string }) => item.text)).toEqual([
      'Kept',
    ])
  })
  it('keeps a message sent at once as unconfirmed, with no definite code, when the session may have taken it', async () => {
    const { queue, detail, options } = await fixture()
    detail.summary.status = 'idle'
    vi.mocked(options.send).mockRejectedValueOnce(new AppError(503, 'storage-unavailable', '持久化失败'))
    await expect(queue.submit(actor, 'task', input('Maybe'))).rejects.toMatchObject({ code: 'storage-unavailable' })
    expect(queue.view('task')).toMatchObject([{ text: 'Maybe', state: 'parked', reason: '发送结果未确认，请重试这一项' }])
  })
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
  it('keeps reserved uploads recoverable when the queue write fails after the reservation', async () => {
    const { queue, dataDir, options } = await fixture()
    options.holdAttachments = vi.fn(async () => {})
    options.releaseAttachments = vi.fn(async () => {})
    const body = { ...input('later'), attachmentIds: ['A'.repeat(22)] }
    const file = join(dataDir, 'queues.json')
    await mkdir(file)
    await expect(queue.submit(actor, 'task', body)).rejects.toMatchObject({ code: 'queue-save-unknown' })
    expect(queue.view('task')).toMatchObject([{ state: 'parked', attachmentCount: 1 }])
    expect(queue.holdsUpload(actor.deviceId, body.requestId)).toBe(true)
    expect(options.releaseAttachments).not.toHaveBeenCalled()
    await rm(file, { recursive: true })
    await queue.submit(actor, 'task', body)
    expect(options.holdAttachments).toHaveBeenCalledTimes(1)
    expect((await PromptQueues.open(options)).view('task')).toMatchObject([{ state: 'parked', attachmentCount: 1 }])
    await queue.remove('task', queue.view('task')[0]!.id)
    expect(options.releaseAttachments).toHaveBeenCalledTimes(1)
    expect(queue.holdsUpload(actor.deviceId, body.requestId)).toBe(false)
  })
  it('retains attachment-only input across restart and sends edited text with the original upload claim', async () => {
    const { queue, detail, options } = await fixture()
    options.holdAttachments = vi.fn(async () => {})
    options.releaseAttachments = vi.fn(async () => {})
    const attachmentIds = ['A'.repeat(22)]
    const body = { ...input(''), attachmentIds }
    await queue.submit(actor, 'task', body)
    const [item] = queue.view('task')
    expect(item).toMatchObject({ text: '', attachmentCount: 1 })
    expect(item!.canSteer).toBeUndefined()
    await expect(queue.submit(actor, 'task', { ...body, attachmentIds: ['B'.repeat(22)] })).rejects.toMatchObject({
      code: 'request-conflict',
    })
    expect(options.holdAttachments).toHaveBeenCalledTimes(1)
    await queue.edit('task', item!.id, 'Check the screenshot', actor)
    await queue.close()
    const resumed = await PromptQueues.open(options)
    expect(resumed.heldAttachmentIds('task')).toEqual(attachmentIds)
    completed(detail)
    await resumed.send('task', item!.id)
    expect(options.send).toHaveBeenCalledWith(
      expect.anything(),
      'task',
      expect.objectContaining({ text: 'Check the screenshot', attachmentIds, attachmentRequestId: body.requestId }),
    )
    expect(resumed.heldAttachmentIds('task')).toEqual([])
    const other = { ...input('remove'), attachmentIds }
    await resumed.submit(actor, 'task', other)
    await resumed.remove('task', resumed.view('task')[0]!.id)
    expect(options.releaseAttachments).toHaveBeenCalledWith(expect.objectContaining(actor), 'task', attachmentIds, other.requestId)
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
  it('changes the observed order exactly once and restores the same order after a restart', async () => {
    const { queue, options } = await fixture()
    for (const words of ['A', 'B', 'C']) await queue.submit(actor, 'task', input(words))
    const before = queue.view('task').map(item => item.id)
    const after = before.toReversed()
    const authorize = vi.fn(async () => {})
    const audit = vi.fn(async () => {})
    const change = { baseOrder: before, order: after, baseRevision: 0 }
    await queue.reorder('task', change, authorize, audit)
    await queue.reorder('task', change, authorize, audit)
    expect(audit).toHaveBeenCalledTimes(1)
    await expect(queue.reorder('task', { ...change, order: [before[1]!, before[0]!, before[2]!] }, authorize)).rejects.toMatchObject({
      code: 'queue-order',
    })
    await expect(queue.reorder('task', { ...change, order: [before[1]!, before[1]!, before[0]!] }, authorize)).rejects.toMatchObject({
      status: 400,
    })
    const reopened = await PromptQueues.open(options)
    expect(reopened.view('task').map(item => item.text)).toEqual(['C', 'B', 'A'])
    await reopened.reorder('task', { order: before, baseOrder: after, baseRevision: 1 }, authorize)
    await expect(reopened.reorder('task', change, authorize)).rejects.toMatchObject({ code: 'queue-order' })
    await reopened.submit(actor, 'task', input('D'))
    await reopened.remove('task', before[0]!)
    expect(reopened.view('task').map(item => item.orderRevision)).toEqual([2, 2, 2])
    for (const item of reopened.view('task')) await reopened.remove('task', item.id)
    await reopened.submit(actor, 'task', input('E'))
    expect(reopened.view('task')[0]!.orderRevision ?? 0).toBe(0)
    await expect(reopened.reorder('task', change, authorize)).rejects.toMatchObject({ code: 'queue-order' })
  })

  it('authorizes after taking the lock even to acknowledge an unchanged order or report a conflict', async () => {
    const { queue } = await fixture()
    for (const words of ['A', 'B', 'C']) await queue.submit(actor, 'task', input(words))
    const baseOrder = queue.view('task').map(item => item.id)
    const change = { baseOrder, order: baseOrder.toReversed(), baseRevision: 0 }
    let release!: () => void
    const audit = vi.fn(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        }),
    )
    const writing = queue.reorder('task', change, async () => {}, audit)
    await vi.waitFor(() => expect(audit).toHaveBeenCalledOnce())
    let allowed = true
    const authorize = async () => {
      if (!allowed) throw new AppError(403, 'scope-required', 'No run')
    }
    const repeat = queue.reorder('task', change, authorize, audit)
    const stale = queue.reorder('task', { ...change, order: [baseOrder[1]!, baseOrder[0]!, baseOrder[2]!] }, authorize, audit)
    allowed = false
    release()
    await writing
    const answers = await Promise.allSettled([repeat, stale])
    for (const answer of answers) expect(answer).toMatchObject({ status: 'rejected', reason: { code: 'scope-required' } })
    expect(audit).toHaveBeenCalledTimes(1)
    allowed = true
    await expect(
      queue.reorder('task', { baseOrder: change.order, order: baseOrder, baseRevision: 1 }, authorize, async () => {
        allowed = false
      }),
    ).rejects.toMatchObject({ code: 'scope-required' })
    expect(queue.view('task').map(item => item.id)).toEqual(change.order)
  })

  it('steers the selected item once even when automatic FIFO delivery and a duplicate request arrive during the steer', async () => {
    const { queue, detail, options } = await fixture()
    let accept!: () => void
    options.steer = vi.fn(
      () =>
        new Promise<'injected'>(resolve => {
          accept = () => resolve('injected')
        }),
    )
    detail.steer = true
    await queue.submit(actor, 'task', input('After the turn'))
    const original = input('During the turn')
    await queue.submit(actor, 'task', original)
    const second = queue.view('task')[1]!
    const send = () => queue.steer('task', second.id, { runId: 'run-1', contentRevision: 0 }, actor, async () => {})
    const first = send()
    await vi.waitFor(() => expect(options.steer).toHaveBeenCalledOnce())
    completed(detail)
    delete detail.steer
    const drain = queue.changed('task')
    const retry = send()
    accept()
    await Promise.all([first, drain, retry])
    const delivery = vi.mocked(options.steer).mock.calls[0]![2]
    expect(delivery).toMatchObject({ text: original.prompt, runId: 'run-1', queuedAt: second.queuedAt })
    expect(delivery.requestId).not.toBe(original.requestId)
    expect(queue.lookup('task', { requestId: original.requestId })).toMatchObject({ state: 'sent', sendRequestId: delivery.requestId })
    expect(options.steer).toHaveBeenCalledTimes(1)
    expect(vi.mocked(options.send).mock.calls.map(call => call[2].text)).toEqual(['After the turn'])
    expect(queue.view('task')).toEqual([])
  })

  it('keeps the original order and delivery IDs on a stale turn, an unsupported item or a definite refusal', async () => {
    const { queue, detail, options } = await fixture()
    options.steer = vi.fn(async () => 'prompt-required' as const)
    detail.steer = true
    const a = input('With this model'),
      b = input('During the turn')
    await queue.submit(actor, 'task', { ...a, model: { providerId: 'p', model: 'm' } })
    await queue.submit(actor, 'task', b)
    const [first, second] = queue.view('task')
    const steer = (id: string, runId = 'run-1') => queue.steer('task', id, { runId, contentRevision: 0 }, actor, async () => {})
    expect(first!.canSteer).toBeUndefined()
    expect(second!.canSteer).toBe(true)
    await expect(steer(first!.id)).rejects.toMatchObject({ code: 'queue-steer-unavailable' })
    await expect(steer(second!.id, 'old-run')).rejects.toMatchObject({ code: 'queue-steer-unavailable' })
    options.canSteer = () => false
    expect(queue.view('task')[1]!.canSteer).toBeUndefined()
    await expect(steer(second!.id)).rejects.toMatchObject({ code: 'queue-steer-unavailable' })
    expect(options.steer).not.toHaveBeenCalled()
    options.canSteer = () => true
    await expect(steer(second!.id)).rejects.toMatchObject({ code: 'queue-steer-unavailable' })
    vi.mocked(options.steer).mockRejectedValueOnce(new AppError(409, 'steer-failed', 'Refused'))
    await expect(steer(second!.id)).rejects.toMatchObject({ code: 'steer-failed' })
    expect(queue.view('task')).toEqual([first, second])
    expect(queue.lookup('task', { id: second!.id })?.sendRequestId).toBe(b.requestId)
    expect(options.send).not.toHaveBeenCalled()
  })

  it('keeps an unknown steer out of fresh turns across restart and settles only from its own user message', async () => {
    const { queue, detail, options } = await fixture()
    options.steer = vi.fn(async () => {
      throw new AppError(409, 'steer-unknown', 'Lost reply')
    })
    detail.steer = true
    await queue.submit(actor, 'task', input('May have arrived'))
    await queue.submit(actor, 'task', input('Later'))
    const [first, second] = queue.view('task').map(item => item.id) as [string, string]
    const authorize = async () => {}
    await expect(queue.steer('task', first, { runId: 'run-1', contentRevision: 0 }, actor, authorize)).rejects.toMatchObject({
      code: 'steer-unknown',
    })
    const reopened = await PromptQueues.open(options)
    expect(reopened.view('task')).toMatchObject([{ state: 'parked', delivery: 'steer-unknown' }, { state: 'parked' }])
    await expect(reopened.steer('task', first, { runId: 'run-1', contentRevision: 1 }, actor, authorize)).rejects.toMatchObject({
      code: 'queue-content-changed',
    })
    completed(detail)
    delete detail.steer
    await expect(
      reopened.reorder('task', { baseOrder: [first, second], order: [second, first], baseRevision: 0 }, authorize),
    ).rejects.toMatchObject({ code: 'queue-order' })
    await expect(reopened.send('task', first)).rejects.toMatchObject({ code: 'steer-unknown' })
    await expect(reopened.steer('task', first, { runId: 'run-1', contentRevision: 0 }, actor, authorize)).rejects.toMatchObject({
      code: 'steer-unknown',
    })
    const requestId = vi.mocked(options.steer).mock.calls[0]![2].requestId
    detail.messages.push({ id: 'other', role: 'user', text: 'May have arrived', requestId: randomUUID(), steered: true, createdAt: '' })
    await reopened.changed('task')
    expect(reopened.view('task')).toHaveLength(2)
    detail.messages.push({ id: 'steer', role: 'user', text: 'May have arrived', requestId, steered: true, createdAt: '' })
    expect((await PromptQueues.open(options)).view('task').map(item => item.id)).toEqual([second])
    await reopened.changed('task')
    await reopened.steer('task', first, { runId: 'run-1', contentRevision: 0 }, actor, authorize)
    expect(reopened.view('task')).toMatchObject([{ id: second, state: 'parked' }])
    expect(options.steer).toHaveBeenCalledTimes(1)
    expect(options.send).not.toHaveBeenCalled()
  })

  it('steers only the version the person read, including on replay after restart', async () => {
    const { queue, detail, options } = await fixture()
    options.steer = vi.fn(async () => 'injected' as const)
    detail.steer = true
    await queue.submit(actor, 'task', input('A'))
    const first = queue.view('task')[0]!
    await queue.edit('task', first.id, 'B', actor)
    const edited = queue.view('task')[0]!
    expect(edited.contentRevision).toBe(1)
    const stale = { runId: 'run-1', contentRevision: first.contentRevision ?? 0 },
      seen = { runId: 'run-1', contentRevision: edited.contentRevision! }
    const steer = (q: PromptQueues, input: typeof stale) => q.steer('task', first.id, input, actor, async () => {})
    await expect(steer(queue, stale)).rejects.toMatchObject({ code: 'queue-content-changed' })
    expect(options.steer).not.toHaveBeenCalled()
    await steer(queue, seen)
    const reopened = await PromptQueues.open(options)
    await expect(steer(reopened, stale)).rejects.toMatchObject({ code: 'queue-content-changed' })
    await steer(reopened, seen)
    expect(options.steer).toHaveBeenCalledOnce()
    expect(vi.mocked(options.steer).mock.calls[0]![2].text).toBe('B')
  })

  it('requires the operator and all queue writer checks before steering edited text', async () => {
    const { queue, detail, options } = await fixture()
    detail.steer = true
    options.steer = vi.fn(async () => 'injected' as const)
    await queue.submit(actor, 'task', input('Before'))
    const id = queue.view('task')[0]!.id
    const editor = { ...actor, deviceId: 'editor' },
      operator = { ...actor, deviceId: 'operator' }
    await queue.edit('task', id, 'After', editor)
    const allowed = vi.fn(async () => {})
    const revoked = new AppError(403, 'scope-required', 'No run')
    allowed.mockRejectedValueOnce(revoked)
    await expect(queue.steer('task', id, { runId: 'run-1', contentRevision: 1 }, operator, allowed)).rejects.toBe(revoked)
    expect(queue.view('task')[0]!.state).toBe('waiting')
    vi.mocked(options.check).mockImplementation(async writer => {
      if (writer.deviceId === editor.deviceId) throw revoked
    })
    await expect(queue.steer('task', id, { runId: 'run-1', contentRevision: 1 }, operator, allowed)).rejects.toMatchObject({
      code: 'queue-paused',
    })
    expect(queue.view('task')[0]!.state).toBe('dropped')
    expect(options.steer).not.toHaveBeenCalled()
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
