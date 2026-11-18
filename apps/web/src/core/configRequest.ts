import type { SessionConfigOption } from '@latch/protocol'
import { ApiError, isUncertain, newRequestId } from './api.ts'
import { defineCopy } from './i18n.ts'

const COPY = defineCopy(
  {
    running: '会话正在运行或等你处理，结束后再核对。',
    subagent: '子 Agent 可能还在运行，结束后再核对。',
    different: (harness: string) => `${harness} 现在用的既不是原来的值，也不是所选的值；结果仍未知。`,
    missing: (harness: string) => `没有读到 ${harness} 的设置，稍后再核对。`,
  },
  {
    running: 'The session is running or waiting for you. Check when it ends.',
    subagent: 'A subagent may still be running. Check after it ends.',
    different: (harness: string) => `${harness} is using a value other than the original or selected value. The outcome is still unknown.`,
    missing: (harness: string) => `Couldn’t read settings from ${harness}. Check again later.`,
  },
)

/** Unknown unless the Host says the change certainly did not apply, which a 5xx refusal of the Harness can say. */
export function configUncertain(cause: unknown): boolean {
  return isUncertain(cause) && !(cause instanceof ApiError && cause.details.configOutcome !== undefined)
}

export interface ConfigRequest {
  readonly requestId: string
  readonly configId: string
  readonly value: string
  unknown: boolean
}

/** Why 核对 could not settle a change, in the words the page shows. */
export function checkReasonText(reason: string | undefined, harness: string): string {
  switch (reason) {
    case 'running':
      return COPY.running
    case 'subagents':
      return COPY.subagent
    case 'neither':
      return COPY.different(harness)
    default:
      return COPY.missing(harness)
  }
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
    if (cause !== undefined && configUncertain(cause)) request.unknown = true
    else this.requests.delete(sessionId)
    return true
  }
  /** The person set an unknown change down on this page; the Host's receipt stays as it is. */
  abandon(sessionId: string, request: ConfigRequest): boolean {
    if (this.requests.get(sessionId) !== request || !request.unknown) return false
    this.requests.delete(sessionId)
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
