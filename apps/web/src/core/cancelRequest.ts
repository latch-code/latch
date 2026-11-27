import { isUncertain, newRequestId } from './api.ts'

type CancelBody = { requestId: string; runId?: string }

/**
 * One stop request per run keeps one `requestId` until the Host has answered definitively, so a retry after a timeout
 * or a dropped connection is the same request: the Host answers it from its receipt, also after it restarted. A stop
 * aimed at a different run (the one that named it ended and another began) is a new request.
 */
export class CancelRequests {
  private readonly pending = new Map<string, { body: CancelBody; sending: boolean }>()
  constructor(private readonly makeId: () => string = newRequestId) {}

  /** Starts one write at a time for the run, reusing its body after an unconfirmed result. */
  begin(sessionId: string, runId: string | undefined): CancelBody | undefined {
    const previous = this.pending.get(sessionId)
    if (previous && previous.body.runId === runId) {
      if (previous.sending) return undefined
      previous.sending = true
      return previous.body
    }
    const body = { requestId: this.makeId(), ...(runId === undefined ? {} : { runId }) }
    this.pending.set(sessionId, { body, sending: true })
    return body
  }

  /** An old run's answer cannot settle a newer run's request or update its stop state. */
  settle(sessionId: string, body: CancelBody, error?: unknown): boolean {
    const pending = this.pending.get(sessionId)
    if (pending?.body !== body) return false
    if (error !== undefined && isUncertain(error)) pending.sending = false
    else this.pending.delete(sessionId)
    return true
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
