import { useSyncExternalStore } from 'react'
import type { ConfirmationTicket } from '@latch/protocol'
import { api as defaultApi, ApiError, ClientError, type ApiOptions } from './api.ts'
import { CONFIRMATION_RESULT_TEXT, describeFailure, HOST_DESKTOP_TEXT } from './securityCopy.ts'

/**
 * Local presence confirmation (Touch ID or the login password on the Host
 * computer). The Host answers a request that needs it with `403 stepup-required`
 * and a ticket; the page waits for the ticket to settle, then sends the
 * identical request again with `x-latch-confirmation`.
 *
 * A presenter shows the states. By default it is the page-wide dock
 * (`ConfirmationDialog`); a caller that shows the states in place (the approval
 * card: the waiting button, the reason in the card) passes its own.
 */

/** Why no confirmation could start: three refusals in a row, another one still open, or a full-access session running. */
export type PausedReason = 'cooldown' | 'busy' | 'blocked'

export type FailureReason = 'denied' | 'expired' | 'cancelled' | 'error'

export type ConfirmationView =
  | { phase: 'waiting'; ticket: ConfirmationTicket }
  | { phase: 'sending'; ticket: ConfirmationTicket }
  | { phase: 'failed'; ticket: ConfirmationTicket; message: string; reason: FailureReason }
  | { phase: 'paused'; reason: PausedReason; message: string; until?: number }

export interface ConfirmationActions {
  /** Waiting: cancels the ticket on the Host. */
  cancel: () => void
  /** Failed or paused: closes the dock; the request stays not executed. */
  dismiss: () => void
}

export interface ConfirmationPresenter {
  show: (view: ConfirmationView, actions: ConfirmationActions) => void
  close: () => void
}

export class ConfirmationError extends ClientError {
  constructor(message: string, reason: FailureReason | PausedReason | 'host-desktop' | 'dismissed', handled: boolean) {
    super(message, reason, { definitive: true, handled })
    this.name = 'ConfirmationError'
  }
}

export interface ConfirmationOptions {
  /** Where the states are shown; the page-wide dock unless the caller shows them in place. */
  presenter?: ConfirmationPresenter
  api?: <T>(path: string, options?: ApiOptions) => Promise<T>
  pollMs?: number
  sleep?: (ms: number, wake: AbortSignal) => Promise<void>
}

function defaultSleep(ms: number, wake: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      wake.removeEventListener('abort', done)
      resolve()
    }
    wake.addEventListener('abort', done, { once: true })
  })
}

/** The Host's refusals to start a confirmation at all, which the presenter explains instead of the caller's form. */
function pausedReason(error: ApiError): PausedReason | undefined {
  if (error.status === 429 && error.code === 'presence-cooldown') return 'cooldown'
  if (error.status === 409 && error.code === 'presence-busy') return 'busy'
  if (error.status === 409 && error.code === 'presence-blocked') return 'blocked'
  return undefined
}

/**
 * Runs `send`; when the Host asks for a local confirmation, shows it, polls the ticket (≤ every 500 ms) and resends
 * with the ticket id once approved. Requests with a `requestId` must resend the identical body. A denial, timeout or
 * error is shown with its reason and settles the call at once (handled), so whatever started it is ready again; the
 * person asks again from there, which sends the same request once more. A Host that refuses to start a confirmation
 * (cooldown, another one open, a full-access session running) is explained the same way.
 */
export async function withConfirmation<T>(send: (confirmation?: string) => Promise<T>, options: ConfirmationOptions = {}): Promise<T> {
  const presenter = options.presenter ?? confirmationStore
  const request = options.api ?? defaultApi
  const pollMs = Math.max(500, options.pollMs ?? 500)
  const sleep = options.sleep ?? defaultSleep
  const closed = { cancel: () => presenter.close(), dismiss: () => presenter.close() }

  let ticket: ConfirmationTicket
  try {
    return await send()
  } catch (error) {
    const paused = error instanceof ApiError ? pausedReason(error) : undefined
    if (paused !== undefined && error instanceof ApiError) {
      const message = describeFailure(error.status, error.code, error.message, error.details)
      const wait = error.details.retryAfter
      presenter.show(
        {
          phase: 'paused',
          reason: paused,
          message,
          ...(paused === 'cooldown' && typeof wait === 'number' && Number.isFinite(wait) ? { until: Date.now() + wait * 1000 } : {}),
        },
        closed,
      )
      throw new ConfirmationError(message, paused, true)
    }
    if (!(error instanceof ApiError && error.status === 403 && error.code === 'stepup-required')) throw error
    if (error.details.stepup?.where === 'host-desktop') throw new ConfirmationError(HOST_DESKTOP_TEXT, 'host-desktop', false)
    if (!error.details.confirmation) throw error
    ticket = error.details.confirmation
  }

  const cancelled = new AbortController()
  const fail = (reason: FailureReason, message: string): never => {
    presenter.show({ phase: 'failed', ticket, message, reason }, closed)
    throw new ConfirmationError(message, reason, true)
  }
  const actions = {
    cancel: () => {
      if (cancelled.signal.aborted) return
      cancelled.abort()
      void request(`confirmations/${encodeURIComponent(ticket.id)}`, { method: 'DELETE' }).catch(() => {
        /* The ticket also expires on the Host. */
      })
    },
    dismiss: () => {
      presenter.close()
    },
  }
  const stop = (): never => {
    presenter.close()
    throw new ConfirmationError(CONFIRMATION_RESULT_TEXT.cancelled, 'cancelled', true)
  }
  presenter.show({ phase: 'waiting', ticket }, actions)

  while (ticket.status === 'pending') {
    await sleep(pollMs, cancelled.signal)
    if (cancelled.signal.aborted) stop()
    try {
      const { confirmation } = await request<{ confirmation: ConfirmationTicket }>(`confirmations/${encodeURIComponent(ticket.id)}`)
      if (confirmation.id === ticket.id) ticket = confirmation
    } catch (error) {
      if (error instanceof ApiError && error.status !== 429 && error.status < 500)
        fail('error', describeFailure(error.status, error.code, error.message, error.details))
      // Network trouble and rate limits: keep polling until the Host reports the outcome or the ticket lapses.
      if (Date.now() > Date.parse(ticket.expiresAt) + 10_000) fail('expired', CONFIRMATION_RESULT_TEXT.expired)
      continue
    }
    if (ticket.status === 'pending') presenter.show({ phase: 'waiting', ticket }, actions)
  }
  if (cancelled.signal.aborted) stop()
  if (ticket.status === 'denied') fail('denied', CONFIRMATION_RESULT_TEXT.denied)
  if (ticket.status === 'expired') fail('expired', CONFIRMATION_RESULT_TEXT.expired)
  if (ticket.status === 'cancelled') fail('cancelled', CONFIRMATION_RESULT_TEXT.cancelled)
  if (ticket.status !== 'approved') fail('error', CONFIRMATION_RESULT_TEXT.error)

  presenter.show({ phase: 'sending', ticket }, actions)
  try {
    const result = await send(ticket.id)
    presenter.close()
    return result
  } catch (error) {
    if (error instanceof ApiError && error.code.startsWith('confirmation-'))
      fail('error', describeFailure(error.status, error.code, error.message, error.details))
    presenter.close()
    throw error
  }
}

/** The page-wide dialog state; `ConfirmationDialog` renders it. */
type Listener = () => void
interface StoreState {
  view: ConfirmationView
  actions: ConfirmationActions
}
let current: StoreState | null = null
const listeners = new Set<Listener>()
const emit = () => {
  for (const listener of listeners) listener()
}

export const confirmationStore: ConfirmationPresenter & {
  subscribe: (listener: Listener) => () => void
  get: () => StoreState | null
} = {
  show: (view, actions) => {
    current = { view, actions }
    emit()
  },
  close: () => {
    if (current !== null) {
      current = null
      emit()
    }
  },
  subscribe: listener => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  get: () => current,
}

export function useConfirmationState(): StoreState | null {
  return useSyncExternalStore(confirmationStore.subscribe, confirmationStore.get, () => null)
}
