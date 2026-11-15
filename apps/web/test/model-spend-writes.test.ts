import { describe, expect, it, vi } from 'vitest'
import { ApiError, ApiTimeoutError, NoAnswerError } from '../src/core/api.ts'
import { ModelSpendWrites, type SpendChange } from '../src/settings/modelSpendWrites.tsx'

const budget = { path: 'model-budgets', scope: 'service', id: 'main', budget: { unit: 'tokens', limit: 50 } } satisfies SpendChange
const price = { path: 'model-prices', providerId: 'main', model: 'model', prices: null } satisfies SpendChange

describe('model spend writes', () => {
  it.each([budget, price])('retries the complete original $path write and clears it on a receipt', async change => {
    const send = vi.fn().mockRejectedValueOnce(new NoAnswerError()).mockResolvedValueOnce(undefined)
    const writes = new ModelSpendWrites(send)
    await expect(writes.write(change, 6)).resolves.toEqual({ kind: 'unknown' })
    const original = writes.read(change)?.request
    const { path, ...values } = change
    expect(original).toEqual({ path, body: { ...values, baseRevision: 6, requestId: expect.any(String) } })

    // A caller reopening the form or reading a newer revision cannot make another write on this target.
    await expect(writes.write(change, 9)).resolves.toEqual({ kind: 'busy' })
    await expect(writes.retry(change)).resolves.toEqual({ kind: 'done' })
    expect(send.mock.calls).toEqual([[original], [original]])
    expect(writes.read(change)).toBeUndefined()
  })

  it('keeps a timeout unknown when a retry is refused or its receipt is gone', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new ApiTimeoutError())
      .mockRejectedValueOnce(new ApiError(403, 'agent-scope-required', '权限已收紧'))
      .mockRejectedValueOnce(new ApiError(409, 'model-spend-conflict', '请重新读取'))
    const writes = new ModelSpendWrites(send)
    const agentBudget = { ...budget, scope: 'agent' } as const
    await expect(writes.write(agentBudget, 6)).resolves.toEqual({ kind: 'unknown' })
    expect(writes.read(budget)).toBeUndefined()
    const original = writes.read(agentBudget)?.request
    await expect(writes.retry(agentBudget)).resolves.toEqual({ kind: 'unknown' })
    expect(writes.read(agentBudget)?.unknown).toEqual({ text: '权限已收紧', retryable: true })
    await expect(writes.retry(agentBudget)).resolves.toEqual({ kind: 'unknown' })
    expect(writes.read(agentBudget)?.unknown?.retryable).toBe(false)
    expect(writes.read(agentBudget)?.request).toBe(original)
    await expect(writes.retry(agentBudget)).resolves.toEqual({ kind: 'busy' })
    expect(send.mock.calls).toEqual([[original], [original], [original]])
    writes.abandon(agentBudget)
    expect(writes.read(agentBudget)).toBeUndefined()
  })

  it('keeps the Host unknown code pending and treats a first audited refusal or a stale editor as known', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, 'model-spend-audit-unavailable', '审计不可用'))
      .mockRejectedValueOnce(new ApiError(409, 'model-spend-conflict', '请重新读取'))
      .mockRejectedValueOnce(new ApiError(503, 'model-spend-write-unknown', '结果未知'))
    const writes = new ModelSpendWrites(send)
    await expect(writes.write(price, 6)).resolves.toEqual({ kind: 'refused', text: '审计不可用' })
    await expect(writes.write(price, 6)).resolves.toEqual({ kind: 'conflict', text: '请重新读取' })
    expect(writes.read(price)).toBeUndefined()
    await expect(writes.write(price, 8)).resolves.toEqual({ kind: 'unknown' })
    expect(writes.read(price)?.request.body.baseRevision).toBe(8)
    expect(new Set(send.mock.calls.map(([request]) => request.body.requestId)).size).toBe(3)
  })
})
