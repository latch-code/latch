import { createContext, useMemo, useSyncExternalStore } from 'react'
import type { CustomizationDocument, CustomizationReceipt, CustomizationView } from '@latch/protocol'
import { api, ApiError, errorMessage, isUncertain, MessageError, newRequestId } from './api.ts'
import { customization, type CustomizationStatus } from './customBoot.ts'

const SERVER: CustomizationStatus = { safe: null, host: null, preview: null }

/** What this page shows of the Host's customisation, and whether this device is on the default instead. */
export function useCustomizationStatus(): CustomizationStatus {
  // Without a document (a server render, a unit test) there is no page to customise.
  const boot = typeof document === 'undefined' ? null : customization()
  return useSyncExternalStore(boot?.subscribe ?? idle, boot?.status ?? server, server)
}
const server = () => SERVER
const idle = () => () => {}

export const readCustomization = (signal?: AbortSignal) => api<CustomizationView>('customization', signal ? { signal } : {})

export type CustomizationChange = { kind: 'apply'; doc: CustomizationDocument } | { kind: 'restore'; revision: number } | { kind: 'reset' }

type CustomizationRequest = CustomizationChange & { requestId: string; baseRevision: number }
export type CustomizationIdentity = { hostId: string; deviceId: string }
type Pending = {
  request: CustomizationRequest
  sending: boolean
  unknown?: { retryable: boolean; text: string }
}
type WriteResult = { kind: 'done' | 'unknown' | 'busy' } | { kind: 'conflict' | 'refused'; text: string }

const keyOf = ({ hostId, deviceId }: CustomizationIdentity) => JSON.stringify([hostId, deviceId])

async function sendCustomization(request: CustomizationRequest) {
  const { kind, ...body } = request
  const path = kind === 'apply' ? 'customization' : `customization/${kind}`
  const receipt = await api<CustomizationReceipt>(path, { method: 'POST', body })
  if (receipt?.requestId !== request.requestId) throw new MessageError('没有收到这次外观修改的回执。')
}

/** Both recovery entries share one original request for each Host and device. */
export class CustomizationWrites {
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly sendRequest = sendCustomization) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  read(identity: CustomizationIdentity): Pending | undefined {
    return this.pending.get(keyOf(identity))
  }

  submit(identity: CustomizationIdentity, change: CustomizationChange, baseRevision: number): Promise<WriteResult> {
    const key = keyOf(identity)
    if (this.pending.has(key)) return Promise.resolve({ kind: 'busy' })
    const request = structuredClone({ ...change, baseRevision, requestId: newRequestId() })
    return this.send(key, { request, sending: true })
  }

  retry(identity: CustomizationIdentity): Promise<WriteResult> {
    const key = keyOf(identity)
    const pending = this.pending.get(key)
    if (!pending?.unknown?.retryable || pending.sending) return Promise.resolve({ kind: 'busy' })
    return this.send(key, { ...pending, sending: true })
  }

  abandon(identity: CustomizationIdentity): void {
    const pending = this.read(identity)
    if (pending?.unknown && !pending.sending) this.update(keyOf(identity))
  }

  private update(key: string, pending?: Pending): void {
    if (pending) this.pending.set(key, pending)
    else this.pending.delete(key)
    for (const listener of this.listeners) listener()
  }

  private async send(key: string, pending: Pending): Promise<WriteResult> {
    this.update(key, pending)
    try {
      await this.sendRequest(pending.request)
      this.update(key)
      return { kind: 'done' }
    } catch (error) {
      const code = error instanceof ApiError ? error.code : undefined
      const definite = code === 'customization-write-pending' || code === 'customization-write-unavailable'
      const conflict = code === 'customization-conflict' || code === 'request-id-reused'
      if (pending.unknown || (!definite && isUncertain(error))) {
        const text = conflict ? '这次请求已无法重放，可以放弃等待。' : errorMessage(error)
        this.update(key, { ...pending, sending: false, unknown: { retryable: !conflict, text } })
        return { kind: 'unknown' }
      }
      this.update(key)
      return { kind: conflict ? 'conflict' : 'refused', text: errorMessage(error) }
    }
  }
}

export interface CustomizationActions {
  pending: Pending | undefined
  submit(change: CustomizationChange, baseRevision: number): Promise<WriteResult>
  retry(): Promise<WriteResult>
  abandon(): void
}

const busy = async (): Promise<WriteResult> => ({ kind: 'busy' })
export const CustomizationActionsContext = createContext<CustomizationActions>({
  pending: undefined,
  submit: busy,
  retry: busy,
  abandon: () => {},
})

export function useCustomizationActions(writes: CustomizationWrites, identity: CustomizationIdentity | null): CustomizationActions {
  const hostId = identity?.hostId
  const deviceId = identity?.deviceId
  const pending = useSyncExternalStore(
    writes.subscribe,
    () => (identity ? writes.read(identity) : undefined),
    () => undefined,
  )
  // A streamed reply also updates App. Keep the provider stable until its recipient or pending request changes.
  return useMemo<CustomizationActions>(() => {
    const target = hostId !== undefined && deviceId !== undefined ? { hostId, deviceId } : null
    return {
      pending,
      submit: (change, baseRevision) => (target ? writes.submit(target, change, baseRevision) : busy()),
      retry: () => (target ? writes.retry(target) : busy()),
      abandon: () => {
        if (target) writes.abandon(target)
      },
    }
  }, [writes, hostId, deviceId, pending])
}
