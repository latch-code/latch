import { useSyncExternalStore } from 'react'
import type { ConfirmationTicket } from '@latch/protocol'
import { api as defaultApi, ApiError, ClientError, type ApiOptions } from './api.ts'
import { describeFailure, HOST_DESKTOP_TEXT } from './securityCopy.ts'

/**
 * Local presence confirmation (Touch ID or the login password on the Host
 * computer). The Host answers a request that needs it with `403 stepup-required`
 * and a ticket; the page waits for the ticket to settle, then sends the
 * identical request again with `x-latch-confirmation`.
 */

export type ConfirmationView =
  | { phase: 'waiting'; ticket: ConfirmationTicket }
  | { phase: 'sending'; ticket: ConfirmationTicket }
  | { phase: 'failed'; ticket: ConfirmationTicket; message: string }

export interface ConfirmationPresenter {
  show: (view: ConfirmationView, actions: { cancel: () => void; dismiss: () => void }) => void
  close: () => void
}

export const CONFIRMATION_RESULT_TEXT = {
  denied: '本机拒绝了此操作。',
  expired: '确认已超时，操作未执行。',
  cancelled: '本机确认已取消，操作未执行。',
  error: '本机确认未完成，操作未执行。',
} as const

export class ConfirmationError extends ClientError {
  constructor(message: string, reason: 'denied' | 'expired' | 'cancelled' | 'error' | 'host-desktop' | 'dismissed', handled: boolean) {
    super(message, reason, { definitive: true, handled })
    this.name = 'ConfirmationError'
  }
}

export interface ConfirmationOptions {
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

/**
 * Runs `send`; when the Host asks for a local confirmation, shows the dialog,
 * polls the ticket (≤ every 500 ms) and resends with the ticket id once
 * approved. Requests with a `requestId` must resend the identical body.
 */
export async function withConfirmation<T>(send: (confirmation?: string) => Promise<T>, options: ConfirmationOptions = {}): Promise<T> {
  const presenter = options.presenter ?? confirmationStore
  const request = options.api ?? defaultApi
  const pollMs = Math.max(500, options.pollMs ?? 500)
  const sleep = options.sleep ?? defaultSleep

  let ticket: ConfirmationTicket
  try {
    return await send()
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 403 && error.code === 'stepup-required')) throw error
    if (error.details.stepup?.where === 'host-desktop') throw new ConfirmationError(HOST_DESKTOP_TEXT, 'host-desktop', false)
    if (!error.details.confirmation) throw error
    ticket = error.details.confirmation
  }

  const cancelled = new AbortController()
  const fail = (reason: 'denied' | 'expired' | 'cancelled' | 'error', message: string): never => {
    presenter.show(
      { phase: 'failed', ticket, message },
      {
        cancel: () => {
          presenter.close()
        },
        dismiss: () => {
          presenter.close()
        },
      },
    )
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
  presenter.show({ phase: 'waiting', ticket }, actions)

  while (ticket.status === 'pending') {
    await sleep(pollMs, cancelled.signal)
    if (cancelled.signal.aborted) {
      presenter.close()
      throw new ConfirmationError(CONFIRMATION_RESULT_TEXT.cancelled, 'cancelled', true)
    }
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
  if (cancelled.signal.aborted) {
    presenter.close()
    throw new ConfirmationError(CONFIRMATION_RESULT_TEXT.cancelled, 'cancelled', true)
  }
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
  actions: { cancel: () => void; dismiss: () => void }
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
