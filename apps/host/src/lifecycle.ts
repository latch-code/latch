import { z } from 'zod'
import type { HostStateEvent, HostStateReason } from '@latch/protocol'

/** Seconds a client waits before its next attempt, by reason, unless the announcement names its own. */
export const RETRY_AFTER: Readonly<Record<HostStateReason, number>> = { restart: 2, update: 10, sleep: 10, shutdown: 15 }
/** A stop reason given ahead of the stop holds this long; a stop after that is announced as a plain shutdown. */
export const STOP_REASON_TTL_MS = 60_000

/**
 * `POST /link/api/host/state` (host.sock only): the desktop app reports the computer going to sleep and waking up, and
 * whoever is about to stop the Host (the desktop app, `pnpm stop --reason`) says why first.
 */
export const hostStateInputSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('stopping'),
      reason: z.enum(['restart', 'update', 'shutdown']),
      retryAfter: z.number().int().min(1).max(3600).optional(),
    })
    .strict(),
  z.object({ state: z.literal('sleeping') }).strict(),
  z.object({ state: z.literal('awake') }).strict(),
])
export type HostStateInput = z.infer<typeof hostStateInputSchema>

/**
 * What the Host announces on the event stream about its own availability. Sleep and wake are announced when reported;
 * a stop is announced by the Host itself as it closes, with the reason reported shortly before, or as a shutdown.
 */
export class HostLifecycle {
  private stop: { reason: Exclude<HostStateReason, 'sleep'>; retryAfter: number; until: number } | undefined

  constructor(
    private readonly instanceId: string,
    private readonly now: () => number,
  ) {}

  /** The event to send now, or undefined when the input only records why the coming stop happens. */
  report(input: HostStateInput): HostStateEvent | undefined {
    const at = new Date(this.now()).toISOString()
    if (input.state === 'stopping') {
      this.stop = {
        reason: input.reason,
        retryAfter: input.retryAfter ?? RETRY_AFTER[input.reason],
        until: this.now() + STOP_REASON_TTL_MS,
      }
      return undefined
    }
    if (input.state === 'sleeping')
      return { type: 'host-state', instanceId: this.instanceId, state: 'sleeping', reason: 'sleep', retryAfter: RETRY_AFTER.sleep, at }
    return { type: 'host-state', instanceId: this.instanceId, state: 'awake', at }
  }

  /** The announcement for this Host stopping now. */
  stopping(): HostStateEvent {
    const stop = this.stop && this.stop.until > this.now() ? this.stop : undefined
    const reason = stop?.reason ?? 'shutdown'
    return {
      type: 'host-state',
      instanceId: this.instanceId,
      state: 'stopping',
      reason,
      retryAfter: stop?.retryAfter ?? RETRY_AFTER[reason],
      at: new Date(this.now()).toISOString(),
    }
  }
}
