import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ModelBudget, ModelPrices, ModelSpendReceipt, ModelSpendWrite } from '@latch/protocol'
import { api, ApiError, errorMessage, isUncertain, MessageError, newRequestId } from '../core/api.ts'

type PriceTarget = { path: 'model-prices'; providerId: string; model: string }
type BudgetTarget = { path: 'model-budgets'; scope: ModelBudget['scope']; id: string }
type SpendTarget = PriceTarget | BudgetTarget

export type SpendChange =
  | (PriceTarget & { prices: ModelPrices | null })
  | (BudgetTarget & { budget: Omit<ModelBudget, 'scope' | 'id'> | null })

interface SpendRequest {
  path: SpendTarget['path']
  body: (Omit<Extract<SpendChange, { path: 'model-prices' }>, 'path'> | Omit<Extract<SpendChange, { path: 'model-budgets' }>, 'path'>)
    & ModelSpendWrite
}

type Pending = {
  request: SpendRequest
  sending: boolean
  clearing: boolean
  unknown?: { text: string; retryable: boolean }
}

type SpendResult = { kind: 'done' | 'unknown' | 'busy' } | { kind: 'conflict' | 'refused'; text: string }

const targetKey = (target: SpendTarget) =>
  JSON.stringify(target.path === 'model-prices' ? [target.path, target.providerId, target.model] : [target.path, target.scope, target.id])

const notAccepted = new Set(['model-spend-audit-unavailable', 'model-spend-write-pending'])
const conflicting = new Set(['model-spend-conflict', 'request-conflict'])

async function putSpend(request: SpendRequest): Promise<void> {
  const reply = await api<ModelSpendReceipt>(request.path, { method: 'PUT', body: request.body })
  if (reply?.ok !== true) throw new MessageError('没有读到这次保存的回执。')
}

/** One pending write per price or budget, for the lifetime of the signed-in device. */
export class ModelSpendWrites {
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly sendRequest = putSpend) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  read(target: SpendTarget): Pending | undefined {
    return this.pending.get(targetKey(target))
  }

  write(change: SpendChange, baseRevision: number): Promise<SpendResult> {
    const key = targetKey(change)
    if (this.pending.has(key)) return Promise.resolve({ kind: 'busy' })
    const { path, ...body } = change
    return this.send(key, {
      request: { path, body: structuredClone({ ...body, requestId: newRequestId(), baseRevision }) },
      sending: true,
      clearing: 'prices' in change ? change.prices === null : change.budget === null,
    })
  }

  retry(target: SpendTarget): Promise<SpendResult> {
    const key = targetKey(target)
    const pending = this.pending.get(key)
    if (!pending?.unknown?.retryable || pending.sending) return Promise.resolve({ kind: 'busy' })
    return this.send(key, { ...pending, sending: true })
  }

  abandon(target: SpendTarget): void {
    const pending = this.read(target)
    if (pending?.unknown && !pending.sending) this.update(targetKey(target))
  }

  private update(key: string, pending?: Pending): void {
    if (pending) this.pending.set(key, pending)
    else this.pending.delete(key)
    for (const listener of this.listeners) listener()
  }

  private async send(key: string, pending: Pending): Promise<SpendResult> {
    this.update(key, pending)
    try {
      await this.sendRequest(pending.request)
      this.update(key)
      return { kind: 'done' }
    } catch (cause) {
      const code = cause instanceof ApiError ? cause.code : ''
      const conflict = conflicting.has(code)
      if (pending.unknown || (!notAccepted.has(code) && (code === 'model-spend-write-unknown' || isUncertain(cause)))) {
        const text = conflict ? '这次请求无法再重放。可以读取当前设置，或放弃等待。' : errorMessage(cause)
        this.update(key, { ...pending, sending: false, unknown: { text, retryable: !conflict } })
        return { kind: 'unknown' }
      }
      this.update(key)
      return { kind: conflict ? 'conflict' : 'refused', text: errorMessage(cause) }
    }
  }
}

const SpendWrites = createContext<ModelSpendWrites | null>(null)

export function ModelSpendWritesProvider({ children }: { children: ReactNode }) {
  const [writes] = useState(() => new ModelSpendWrites())
  return <SpendWrites value={writes}>{children}</SpendWrites>
}

export function useSpendWrite(target: SpendTarget) {
  const writes = useContext(SpendWrites)
  if (!writes) throw new Error('Missing model spend write provider')
  const pending = useSyncExternalStore(writes.subscribe, () => writes.read(target))
  return {
    pending,
    submit: (change: SpendChange, revision: number) => writes.write(change, revision),
    retry: () => writes.retry(target),
    abandon: () => writes.abandon(target),
  }
}
