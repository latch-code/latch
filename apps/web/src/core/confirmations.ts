import { useLayoutEffect, useSyncExternalStore } from 'react'
import type { BlockingTask, ConfirmationTicket, PresenceAction } from '@latch/protocol'
import { api as defaultApi, ApiError, ClientError, type ApiOptions } from './api.ts'
import { blockedDetail } from './blocking.ts'
import { shellConfirmations, type ShellConfirmationResult } from './shell.ts'
import { CONFIRMATION_RESULT_TEXT, describeFailure, HOST_DESKTOP_TEXT } from './securityCopy.ts'

/**
 * Local presence confirmation (Touch ID or the login password on the Host
 * computer). The Host answers a request that needs it with `403 stepup-required`
 * and a ticket; the page waits for the ticket to settle, then sends the
 * identical request again with `x-latch-confirmation`.
 *
 * A presenter shows the states. By default each call is a flow in the page's
 * store, shown by the inline card (`InlineConfirm`) of the place that started
 * it: the card that was active when the flow began keeps it. Leaving the card
 * cancels a pending confirmation. The approval card passes its own presenter.
 */

/** Why no confirmation could start: three refusals in a row, another one still open, or a full-access session running. */
export type PausedReason = 'cooldown' | 'busy' | 'blocked'

export type FailureReason = 'denied' | 'expired' | 'cancelled' | 'error'

/** What a `presence-blocked` refusal says: the confirmation refused and, for a device that may see them, the sessions. */
export interface Blocked {
  action?: PresenceAction
  tasks: BlockingTask[]
}

export type ConfirmationView =
  | { phase: 'waiting'; ticket: ConfirmationTicket }
  | { phase: 'sending'; ticket: ConfirmationTicket }
  | { phase: 'failed'; ticket: ConfirmationTicket; message: string; reason: FailureReason }
  | { phase: 'paused'; reason: PausedReason; message: string; until?: number; blocked?: Blocked }

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
  /** Where the states are shown; the active inline card unless the caller provides its own presenter. */
  presenter?: ConfirmationPresenter
  api?: <T>(path: string, options?: ApiOptions) => Promise<T>
  nativeConfirm?: (id: string) => Promise<ShellConfirmationResult>
  pollMs?: number
  sleep?: (ms: number, wake: AbortSignal) => Promise<void>
  /** Told the ticket the Host opened, and `null` just before the request goes out again with it. */
  onTicket?: (id: string | null) => void
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

/** The refused action and sessions use the same validation as pairing notices. */
export function blockedDetails(details: Readonly<Record<string, unknown>>): Blocked {
  return blockedDetail(details)
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
  const presenter = options.presenter ?? confirmationStore.begin()
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
          ...(paused === 'blocked' ? { blocked: blockedDetails(error.details) } : {}),
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
  options.onTicket?.(ticket.id)
  presenter.show({ phase: 'waiting', ticket }, actions)
  if (ticket.confirmationMethod === 'shell-local') {
    const confirm = options.nativeConfirm ?? shellConfirmations()?.confirm
    let outcome: ShellConfirmationResult
    try {
      outcome = confirm ? await confirm(ticket.id) : { status: 'failed', code: 'confirmation-shell-unavailable' }
    } catch {
      outcome = { status: 'failed', code: 'confirmation-failed' }
    }
    if (cancelled.signal.aborted) stop()
    if (outcome.status !== 'confirmed') {
      actions.cancel()
      if (outcome.status === 'cancelled') stop()
      fail('error', describeFailure(409, outcome.status === 'failed' ? outcome.code : 'presence-busy', ''))
    }
  }

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
  if (ticket.status === 'denied')
    fail('denied', ticket.form?.startsWith('start.') ? CONFIRMATION_RESULT_TEXT.startDenied : CONFIRMATION_RESULT_TEXT.denied)
  if (ticket.status === 'expired') fail('expired', CONFIRMATION_RESULT_TEXT.expired)
  if (ticket.status === 'cancelled') fail('cancelled', CONFIRMATION_RESULT_TEXT.cancelled)
  if (ticket.status !== 'approved')
    fail('error', ticket.failure === 'biometry-lockout' ? CONFIRMATION_RESULT_TEXT.lockout : CONFIRMATION_RESULT_TEXT.error)

  options.onTicket?.(null)
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

/**
 * The page's confirmation flows: one at a time, as the Host allows. A flow belongs to the inline card that was active
 * when it began (the most recently activated one), and stays with it while that card is mounted. A card that goes away
 * cancels its pending confirmation and removes its flow. A request without an active card is refused.
 */
type Listener = () => void
export interface ConfirmationFlow {
  id: number
  view: ConfirmationView
  actions: ConfirmationActions
  /** The inline card that shows it. */
  host?: string
}
let current: ConfirmationFlow | null = null
let flows = 0
/** The flow `confirmationStore.show` drives, for presenters that wrap the store (they predate flows). */
let wrapped: { id: number; presenter: ConfirmationPresenter } | null = null
/** Each mounted card: when it was last activated (0 while inactive) and its rank among cards active at once. */
const hosts = new Map<string, { at: number; rank: number }>()
let activations = 0
const listeners = new Set<Listener>()
const emit = () => {
  for (const listener of listeners) listener()
}

/** The card the next flow goes to: of the active ones, the highest rank, then the one activated last. */
function topHost(): string | undefined {
  let top: [string, { at: number; rank: number }] | undefined
  for (const entry of hosts) {
    const [, state] = entry
    if (state.at === 0) continue
    if (top === undefined || state.rank > top[1].rank || (state.rank === top[1].rank && state.at > top[1].at)) top = entry
  }
  return top?.[0]
}

export const confirmationStore = {
  /**
   * The store as a presenter itself, for a caller that wraps it to follow the states (a button's own label): each
   * `show` after a `close` begins a new flow, routed like any other.
   */
  show(view: ConfirmationView, actions: ConfirmationActions): void {
    if (wrapped === null || (current !== null && current.id !== wrapped.id)) {
      const presenter = confirmationStore.begin()
      wrapped = { id: flows, presenter }
    }
    wrapped.presenter.show(view, actions)
  },
  close(): void {
    wrapped?.presenter.close()
    wrapped = null
  },
  /** A presenter for one withConfirmation call. */
  begin(): ConfirmationPresenter {
    const id = ++flows
    return {
      show: (view, actions) => {
        const host = current?.id === id ? current.host : topHost()
        if (host === undefined) {
          if (view.phase === 'waiting') actions.cancel()
          throw new ConfirmationError(
            view.phase === 'failed' || view.phase === 'paused' ? view.message : CONFIRMATION_RESULT_TEXT.cancelled,
            view.phase === 'paused' ? view.reason : 'cancelled',
            false,
          )
        }
        current = { id, view, actions, host }
        emit()
      },
      close: () => {
        if (current?.id === id) {
          current = null
          emit()
        }
      },
    }
  },
  /** Marks an inline card mounted; `active` is true while its place has a request in flight. */
  host(id: string, active: boolean, rank = 0): void {
    const was = hosts.get(id)
    const at = active ? (was !== undefined && was.at > 0 ? was.at : ++activations) : 0
    hosts.set(id, { at, rank })
  },
  unhost(id: string): void {
    hosts.delete(id)
    if (current?.host !== id) return
    const flow = current
    current = null
    if (flow.view.phase === 'waiting') flow.actions.cancel()
    emit()
  },
  subscribe: (listener: Listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  get: () => current,
}

/**
 * The flow an inline card shows, while it is mounted; `active` while its place waits for an answer. A higher `rank`
 * wins over other cards active at the same time.
 */
export function useInlineConfirmation(id: string, active: boolean, rank = 0): ConfirmationFlow | null {
  useLayoutEffect(() => {
    confirmationStore.host(id, active, rank)
  }, [id, active, rank])
  useLayoutEffect(
    () => () => {
      confirmationStore.unhost(id)
    },
    [id],
  )
  const flow = useSyncExternalStore(confirmationStore.subscribe, confirmationStore.get, () => null)
  return flow?.host === id ? flow : null
}
