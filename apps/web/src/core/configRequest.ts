import type { SessionConfigOption } from '@latch/protocol'
import { isUncertain, newRequestId } from './api.ts'

export interface ConfigRequest {
  readonly requestId: string
  readonly configId: string
  readonly value: string
  unknown: boolean
}

/** A late reply belongs to its original session; uncertain changes keep their exact identity until reconciled. */
export class ConfigRequests {
  private readonly requests = new Map<string, ConfigRequest>()
  get(sessionId: string): ConfigRequest | undefined {
    return this.requests.get(sessionId)
  }
  begin(sessionId: string, configId: string, value: string): ConfigRequest | undefined {
    if (this.requests.has(sessionId) || this.requests.size >= 256) return
    const request = { requestId: newRequestId(), configId, value, unknown: false }
    this.requests.set(sessionId, request)
    return request
  }
  settle(sessionId: string, request: ConfigRequest, cause?: unknown): boolean {
    if (this.requests.get(sessionId) !== request) return false
    if (cause !== undefined && isUncertain(cause)) request.unknown = true
    else this.requests.delete(sessionId)
    return true
  }
  reconcile(sessionId: string, request: ConfigRequest, config: readonly SessionConfigOption[], receipt?: string): boolean {
    if (this.requests.get(sessionId) !== request || !request.unknown) return false
    // An old Host has no receipts. A different value cannot prove a timed-out change will never apply later.
    if (receipt !== undefined) {
      if (receipt !== 'applied' && receipt !== 'failed') return false
    } else if (!config.some(item => item.id === request.configId && item.currentValue === request.value)) return false
    this.requests.delete(sessionId)
    return true
  }
}
