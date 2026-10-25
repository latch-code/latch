import { isUncertain, newRequestId } from './api.ts'

/**
 * One stop request per run keeps one `requestId` until the Host has answered definitively, so a retry after a timeout
 * or a dropped connection is the same request: the Host answers it from its receipt, also after it restarted. A stop
 * aimed at a different run (the one that named it ended and another began) is a new request.
 */
export class CancelRequests {
  private readonly pending = new Map<string, { runId: string | undefined; requestId: string }>()
  constructor(private readonly makeId: () => string = newRequestId) {}

  /** The body for stopping `runId` in this session: the same request while an earlier one is unanswered. */
  bodyFor(sessionId: string, runId: string | undefined): { requestId: string; runId?: string } {
    const previous = this.pending.get(sessionId)
    const requestId = previous && previous.runId === runId ? previous.requestId : this.makeId()
    this.pending.set(sessionId, { runId, requestId })
    return { requestId, ...(runId === undefined ? {} : { runId }) }
  }

  /** Keep the request only when the outcome is unknown (network error, timeout, 408, ≥ 500). */
  settle(sessionId: string, error?: unknown): void {
    if (error === undefined || !isUncertain(error)) this.pending.delete(sessionId)
  }
}

/**
 * Reads the Host's answer to a stop. `ended`: the run it named had already ended; `newer` adds that the Host did not
 * name the run's final status, because another run had begun since. An older Host answers without a receipt.
 */
export function cancelAnswer(value: unknown): 'stopped' | 'ended' | 'newer' | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const receipt = (value as { receipt?: unknown }).receipt
  if (typeof receipt !== 'object' || receipt === null) return undefined
  const { outcome, status } = receipt as { outcome?: unknown; status?: unknown }
  if (outcome === 'stopped') return 'stopped'
  if (outcome === 'ended') return typeof status === 'string' ? 'ended' : 'newer'
  return undefined
}
