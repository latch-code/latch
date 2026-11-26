import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMention } from '@latch/protocol'
import { ConsultationReplies } from '../src/agent-consultations.ts'

const sent: AgentMention = {
  id: 'receipt',
  requestId: 'request',
  initiator: 'agent',
  sourceAgentId: 'source',
  targetAgentId: 'peer',
  targetSessionId: 'target-chat',
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'running',
  text: 'Please review',
}

describe('waiting for a consultation receipt', () => {
  beforeEach(() => vi.useFakeTimers({ now: 0 }))
  afterEach(() => vi.useRealTimers())

  it('checks authority on a receipt that finished before subscribing, without reading it again', async () => {
    const read = vi.fn()
    const authorize = vi.fn().mockImplementation(() => {
      throw new Error('revoked')
    })
    await expect(
      new ConsultationReplies().wait({ ...sent, status: 'completed' }, { signal: new AbortController().signal, authorize, read }),
    ).rejects.toThrow('revoked')
    expect(read).not.toHaveBeenCalled()
  })

  it.each(['waiting-approval', 'completed'] as const)('returns %s on a target notification without a polling delay', async status => {
    const replies = new ConsultationReplies()
    let receipt = sent
    const read = vi.fn(async () => receipt)
    const waiting = replies.wait(sent, { read, signal: new AbortController().signal, authorize: () => {} })
    await vi.advanceTimersByTimeAsync(40)
    for (let n = 0; n < 200; n++) {
      replies.observed({ id: 'other-chat', status: 'idle' })
      replies.observed({ id: 'target-chat', status: 'running' })
    }
    expect(read).toHaveBeenCalledTimes(1)
    receipt = { ...sent, status }
    replies.observed({ id: 'target-chat', status: status === 'completed' ? 'idle' : status })
    await expect(waiting).resolves.toEqual(receipt)
    expect(Date.now()).toBe(40)
    expect(read).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains a settlement notification received during a stale read of the receipt', async () => {
    const replies = new ConsultationReplies()
    let finish!: (receipt: AgentMention) => void
    const stale = new Promise<AgentMention>(resolve => {
      finish = resolve
    })
    const completed = { ...sent, status: 'completed' as const }
    const read = vi.fn<() => Promise<AgentMention>>(async () => completed).mockReturnValueOnce(stale)
    const waiting = replies.wait(sent, { read, signal: new AbortController().signal, authorize: () => {} })
    replies.observed({ id: 'target-chat', status: 'idle' })
    finish(sent)
    await vi.advanceTimersByTimeAsync(1)
    await expect(waiting).resolves.toEqual(completed)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('returns the live receipt at the deadline even with a silent driver', async () => {
    const replies = new ConsultationReplies()
    const read = vi.fn(async () => sent)
    const waiting = replies.wait(sent, { read, signal: new AbortController().signal, authorize: () => {} })
    await vi.advanceTimersByTimeAsync(44_999)
    expect(read).toHaveBeenCalledTimes(9)
    await vi.advanceTimersByTimeAsync(1)
    await expect(waiting).resolves.toEqual(sent)
    expect(read).toHaveBeenCalledTimes(10)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['cancel', 'revoke'] as const)('stops waiting after %s without another read of the target chat', async action => {
    const replies = new ConsultationReplies()
    const controller = new AbortController()
    const authorize = vi.fn()
    const read = vi.fn(async () => sent)
    const waiting = replies.wait(sent, { read, signal: controller.signal, authorize })
    const rejection = expect(waiting).rejects.toThrow(action)
    await vi.advanceTimersByTimeAsync(1)
    if (action === 'cancel') controller.abort(new Error(action))
    else {
      authorize.mockImplementation(() => {
        throw new Error(action)
      })
      await vi.advanceTimersByTimeAsync(749)
    }
    await rejection
    replies.observed({ id: 'target-chat', status: 'idle' })
    expect(read).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
