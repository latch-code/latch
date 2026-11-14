// What the Host does with a model request across a session's candidates, for the gateway and the built-in harness alike:
// which service is tried first, how a failure is sorted before anything is decided, when the same service is tried again
// and when the next one is, and what real requests say of each service's health. It never sends a request of its own.
import { AppError } from '@latch/sdk'
import type { ModelFailureClass, ServiceHealth } from '@latch/protocol'

/** Time as the scheduler reads it, so a test can move it. */
export interface SchedulerClock {
  now(): number
  /** Resolves after `ms`, or rejects with the signal's reason. */
  sleep(ms: number, signal: AbortSignal): Promise<void>
  /** In [0, 1). */
  random(): number
}

export const systemClock: SchedulerClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason as Error)
      const done = () => {
        signal.removeEventListener('abort', stop)
        resolve()
      }
      const timer = setTimeout(done, ms)
      timer.unref()
      const stop = () => {
        clearTimeout(timer)
        reject(signal.reason as Error)
      }
      signal.addEventListener('abort', stop, { once: true })
    }),
  random: () => Math.random(),
}

export const SCHEDULE = {
  /** All a request may take before its reply begins, waits and retries included. */
  budgetMs: 90_000,
  firstByteMs: 60_000,
  /** The same service again after a failure on its side, each ±30%. */
  backoffMs: [1000, 3000],
  jitter: 0.3,
  /** A 429 with no other candidate waits once when the service asks for no more than this. */
  rateWaitMs: 10_000,
  /** How long a service that ran out of balance is passed over, longer each time in a row. */
  restMs: [30 * 60_000, 2 * 3_600_000, 8 * 3_600_000, 24 * 3_600_000],
  breaker: { consecutive: 4, windowMs: 120_000, windowRequests: 10, openMs: 60_000 },
  /** A request waits this long for a free place of its service. */
  slotWaitMs: 30_000,
} as const

/** What a refusal says when it is about the key itself, as services word it. */
const AUTH_WORDS =
  /api[_ -]?key|invalid[_ -]?(?:x-)?(?:api|auth|token)|unauthori[sz]ed|unauthenticated|authentication|incorrect.{0,20}key|invalid.{0,20}(?:key|token|credential)|expired.{0,20}(?:key|token)/iu

/**
 * What `sort` reads of a failed answer: its status and what its body says, never kept. A 403 is the key's fault only
 * when the service says so; any other 403 (a region, a model the account may not use) leaves the key alone.
 */
export function classifyStatus(status: number, text = ''): ModelFailureClass {
  if (status === 402 || /insufficient[_ ]quota|insufficient[_ ]balance|billing[_ ]hard[_ ]limit|credit balance is too low/iu.test(text))
    return 'quota'
  if (status === 401) return 'auth'
  if (status === 403) return AUTH_WORDS.test(text) ? 'auth' : 'forbidden'
  if (status === 429) return 'rate'
  if (status === 408 || status >= 500) return status === 501 || status === 505 ? 'request' : 'server'
  return 'request'
}

/** `retry-after` in milliseconds: seconds or a date, as HTTP writes it; undefined when absent or unreadable. */
export function retryAfterMs(value: string | null | undefined, now: number): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(value)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

/** One candidate as the scheduler knows it: the service, and what its settings were when the caller bound it. */
export interface ScheduledCandidate {
  providerId: string
  fingerprint: string
}

export interface AttemptFailure<R> {
  class: Exclude<ModelFailureClass, 'unavailable' | 'circuit-open'>
  retryAfterMs?: number
  /**
   * The request never reached the service (no connection was made), so it cannot have done anything there. Absent for
   * a failure after it was sent, a connection that broke under way among them.
   */
  unsent?: true
  /** What the caller answers with when nothing else is tried after this. */
  reply: R
}

/**
 * How one try at one candidate ended. `skip`: this candidate cannot take the request now (it is off, removed, changed, or
 * cannot do what the request asks), and nothing was sent to it.
 */
export type AttemptResult<T, R> = { ok: true; value: T } | ({ ok: false } & AttemptFailure<R>) | { skip: true }

/** The first-byte clock of one try, as the try itself moves it. */
export interface AttemptTimer {
  /** The service began to answer: its response headers, or any byte or event of its stream. The limit is met. */
  began(): void
  /** While `wait` is pending the clock stands still: waiting for the Host's own permit is not the service's silence. */
  waiting<W>(wait: Promise<W>): Promise<W>
}

export interface DispatchInput<T, R> {
  sessionId: string
  candidates: readonly ScheduledCandidate[]
  /** The candidate this turn already moved to, tried first. */
  start?: number
  signal: AbortSignal
  /**
   * False for a request whose whole answer comes at once: it may rightly take longer than any first-byte limit, so it
   * has none, and its length says nothing of the service's health.
   */
  firstByte?: boolean
  /**
   * False when sending the same request twice could do something twice on the service's side (tools it runs itself,
   * state it keeps). Then only a failure that proves the request did not run lets it go anywhere again, in place or to
   * another candidate: a connection that was never made, a refused key, a spent balance, a 429. A 5xx, a silence or a
   * connection that broke after it was sent is the answer.
   */
  retryServer?: boolean
  /** Sends the request to candidate `index` and resolves when its reply begins or fails. `signal` also ends on the first-byte timeout. */
  attempt(index: number, signal: AbortSignal, timer: AttemptTimer): Promise<AttemptResult<T, R>>
  /** What a try that ran out of time answers with. */
  timedOut(index: number): R
  /** Before the request goes to another candidate; a throw keeps it where it is, and the failure is answered. */
  beforeSwitch(from: number, to: number, reason: ModelFailureClass): Promise<void>
}

export type DispatchResult<T, R> =
  | {
      ok: true
      index: number
      value: T
      /** How the reply ended, once: complete, broken after it began, or given up on by the caller. */
      done(end: 'complete' | 'broken' | 'aborted'): void
    }
  | { ok: false; index: number; failure: AttemptFailure<R> }
  /**
   * Nothing could be tried: every candidate is held back or gone. `retryAfterMs` when one opens again by itself.
   * `changed`: the first candidate's own service is no longer what the caller bound, which is the caller's to say; the
   * request never moves on from that by itself.
   */
  | { ok: false; index?: undefined; failure?: undefined; retryAfterMs?: number; changed?: true }

interface Waiter {
  sessionId: string
  admit(): void
}

interface ServiceState {
  fingerprint: string
  consecutive: number
  /** Results of the last two minutes: when, and whether it failed. */
  window: Array<{ at: number; failed: boolean }>
  openedAt: number | undefined
  trial: boolean
  /** The key was refused: other services come first until then, when a real request asks again. */
  keyInvalidUntil: number | undefined
  restStep: number
  restUntil: number | undefined
  /** The service answered 429: other services come first until then. Nothing of a failing service is said of it. */
  rateUntil: number | undefined
  last: { class: ModelFailureClass; at: number } | undefined
  firstByte: number[]
  active: number
  waiting: Waiter[]
}

const TIMEOUT: unique symbol = Symbol('timeout')
const median = (values: readonly number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!

export interface ModelSchedulerDeps {
  clock?: SchedulerClock
  /** The service's limit of requests at a time, when it has one. */
  limit?(providerId: string): number | undefined
  /**
   * What the service's settings are now. A candidate bound to anything else is stale: it is never tried, and it never
   * touches what is known of the service. Without it every candidate is taken at its word.
   */
  fingerprint?(providerId: string): string | undefined
  /** A service's health changed in a way a person sees. */
  changed?(providerId: string): void
  /** A session began or stopped waiting for a place. */
  queued?(sessionId: string): void
}

export class ModelScheduler {
  private readonly services = new Map<string, ServiceState>()
  /** By session: what each of its waiting requests waits for, a service's place or (undefined) the Host's own permit. */
  private readonly waits = new Map<string, Map<object, string | undefined>>()
  readonly clock: SchedulerClock

  constructor(private readonly deps: ModelSchedulerDeps = {}) {
    this.clock = deps.clock ?? systemClock
  }

  /** What real requests say of the service now; undefined while it works or nothing was sent yet. */
  health(providerId: string): ServiceHealth | undefined {
    const state = this.services.get(providerId)
    if (!state) return undefined
    const now = this.clock.now()
    const iso = (at: number) => new Date(at).toISOString()
    const last = state.last ? { last: state.last.class, at: iso(state.last.at) } : {}
    // Each state ends by itself: once its time is up the next real request asks the service again.
    if (state.keyInvalidUntil !== undefined && now < state.keyInvalidUntil)
      return { state: 'key-invalid', ...last, until: iso(state.keyInvalidUntil) }
    if (state.restUntil !== undefined && now < state.restUntil) return { state: 'quota', ...last, until: iso(state.restUntil) }
    if (state.openedAt !== undefined) {
      const until = state.openedAt + SCHEDULE.breaker.openMs
      if (state.trial) return { state: 'failing', ...last }
      if (now < until) return { state: 'failing', ...last, until: iso(until) }
    }
    if (state.rateUntil !== undefined && now < state.rateUntil) return { state: 'rate', ...last, until: iso(state.rateUntil) }
    return this.slow(state) ? { state: 'slow' } : undefined
  }

  /**
   * What a session's request waits for, when one does: `providerId` for a place of that service, none for the Host's own
   * permit. A wait for a service's place is named first.
   */
  queueOf(sessionId: string): { providerId?: string } | undefined {
    const held = this.waits.get(sessionId)
    if (!held?.size) return undefined
    const providerId = [...held.values()].find(value => value !== undefined)
    return providerId === undefined ? {} : { providerId }
  }

  /** Marks `sessionId` as waiting, for a place of `providerId` or for the Host's own permit, until the returned function is called. */
  waiting(sessionId: string, providerId?: string): () => void {
    const key = {}
    let held = this.waits.get(sessionId)
    if (!held) this.waits.set(sessionId, (held = new Map()))
    held.set(key, providerId)
    this.deps.queued?.(sessionId)
    return () => {
      const current = this.waits.get(sessionId)
      if (!current?.delete(key)) return
      if (current.size === 0) this.waits.delete(sessionId)
      this.deps.queued?.(sessionId)
    }
  }

  async dispatch<T, R>(input: DispatchInput<T, R>): Promise<DispatchResult<T, R>> {
    const { candidates, signal } = input
    const { clock } = this
    // The time a request has before its reply begins; what it spends waiting its turn, for a service's place or the
    // Host's own permit, is added back.
    let deadline = clock.now() + SCHEDULE.budgetMs
    const waited = (ms: number) => {
      deadline += ms
    }
    // The session's own service is no longer what the caller bound: that is for the caller to say, as it always was.
    // Going on at another candidate from here would be a switch nobody put on record.
    if (candidates[0] && this.stale(candidates[0])) return { ok: false, changed: true }
    let order = this.order(candidates, input.start)
    // Starting anywhere but the first candidate or the one this turn already moved to is a switch like any other.
    if (order[0] !== undefined && order[0] !== 0 && order[0] !== input.start) {
      try {
        await input.beforeSwitch(0, order[0], this.heldFor(candidates[0]!))
      } catch {
        order = candidates.flatMap((candidate, index) => (this.stale(candidate) ? [] : [index]))
      }
    }
    let last: { index: number; failure: AttemptFailure<R> } | undefined
    /** A later candidate's own refusal of the request: answered only when nothing else failed. */
    let refused: { index: number; failure: AttemptFailure<R> } | undefined
    let reopens: number | undefined
    /** A later candidate being full is no answer while an earlier one really failed: that failure is. */
    const busyAfterFailure = (error: unknown) =>
      error instanceof AppError && error.code === 'gateway-busy' && (last ?? refused) !== undefined
    /** The first candidate after `position` that may be tried now. */
    const nextAfter = (position: number): number | undefined => {
      for (let next = position + 1; next < order.length; next++) if (this.gate(candidates[order[next]!]!) !== 'open') return next
      return undefined
    }
    /** Moves on from `position` for `reason`, on record first; undefined when it stays. */
    const moveOn = async (position: number, reason: ModelFailureClass): Promise<number | undefined> => {
      const next = nextAfter(position)
      // With no time left nothing would be sent there, so nothing says it was.
      if (next === undefined || deadline - clock.now() <= 0) return undefined
      try {
        await input.beforeSwitch(order[position]!, order[next]!, reason)
      } catch {
        return undefined
      }
      return next
    }
    let position = 0
    while (position < order.length) {
      const index = order[position]!
      const candidate = candidates[index]!
      const state = this.state(candidate.providerId, candidate.fingerprint)
      const gate = this.gate(candidate)
      if (gate === 'open') {
        const opens = (state.openedAt ?? clock.now()) + SCHEDULE.breaker.openMs - clock.now()
        reopens = Math.min(reopens ?? Infinity, Math.max(opens, 1000))
        const next = await moveOn(position, 'circuit-open')
        if (next === undefined) break
        position = next
        continue
      }
      const trial = gate === 'trial'
      if (trial) state.trial = true
      let release: (() => void) | undefined
      // A reply that began keeps its place and its trial until it ends; anything else gives both back here.
      let answered = false
      const leave = () => {
        if (answered) return
        if (trial) state.trial = false
        release?.()
        release = undefined
      }
      let moved: number | undefined
      try {
        const asked = clock.now()
        release = await this.slot(candidate.providerId, state, input.sessionId, signal)
        waited(clock.now() - asked)
        let retries = 0
        let waitedRate = false
        for (;;) {
          signal.throwIfAborted()
          const remaining = deadline - clock.now()
          if (remaining <= 0) break
          const started = clock.now()
          const limited = input.firstByte !== false
          const result = await this.timed(index, limited ? Math.min(SCHEDULE.firstByteMs, remaining) : undefined, input, waited)
          signal.throwIfAborted()
          if ('skip' in result) {
            moved = await moveOn(position, 'unavailable')
            break
          }
          if (result.ok) {
            if (limited) this.firstByte(candidate.providerId, state, clock.now() - started)
            // The trial was whether the service answers at all: it does, so others may ask it again now, not only
            // once this reply, which may run for minutes, has ended.
            if (trial) this.reopened(candidate.providerId, state)
            const held = release
            answered = true
            let ended = false
            return {
              ok: true,
              index,
              value: result.value,
              done: end => {
                if (ended) return
                ended = true
                held?.()
                if (end === 'complete') this.succeeded(candidate.providerId, state)
                else if (end === 'broken') this.failed(candidate.providerId, state, 'stream')
              },
            }
          }
          const { ok: _ok, ...failure } = result
          if (failure.class === 'request') {
            // The request's own fault says nothing of the service. From the session's own service it is the answer; from
            // a later candidate it is that candidate's alone, passed over like one that cannot take the request.
            if (index === 0) return { ok: false, index, failure }
            refused ??= { index, failure }
            moved = await moveOn(position, 'unavailable')
            break
          }
          last = { index, failure }
          this.failed(candidate.providerId, state, failure.class, failure.retryAfterMs)
          // The request may have run there already, wholly or in part. Sent again, here or anywhere, it could run twice.
          if (
            input.retryServer === false
            && (failure.class === 'server' || failure.class === 'timeout' || (failure.class === 'network' && !failure.unsent))
          )
            return { ok: false, ...last }
          if (failure.class === 'rate') {
            const next = await moveOn(position, 'rate')
            if (next !== undefined) {
              moved = next
              break
            }
            const wait = failure.retryAfterMs
            if (waitedRate || wait === undefined || wait > SCHEDULE.rateWaitMs || wait >= deadline - clock.now())
              return { ok: false, ...last }
            waitedRate = true
            await clock.sleep(wait, signal)
            continue
          }
          // Nothing of these is worth asking the same service again: its key, its balance, its refusal, or a silence
          // that already took the whole first-byte time. Asking again after a silence could also run the request twice.
          if (failure.class === 'auth' || failure.class === 'forbidden' || failure.class === 'quota' || failure.class === 'timeout') {
            moved = await moveOn(position, failure.class)
            break
          }
          // A fast failure on the service's side: the same service twice more, unless it is being held back by now.
          const pause = SCHEDULE.backoffMs[retries]
          if (pause !== undefined && state.openedAt === undefined) {
            const jittered = Math.round(pause * (1 - SCHEDULE.jitter + 2 * SCHEDULE.jitter * clock.random()))
            if (jittered < deadline - clock.now()) {
              retries++
              await clock.sleep(jittered, signal)
              continue
            }
          }
          moved = await moveOn(position, failure.class)
          break
        }
      } catch (error) {
        if (!busyAfterFailure(error)) throw error
        break
      } finally {
        leave()
      }
      if (moved === undefined) break
      position = moved
    }
    const answer = last ?? refused
    if (answer) return { ok: false, ...answer }
    return { ok: false, ...(reopens !== undefined ? { retryAfterMs: reopens } : {}) }
  }

  /**
   * One try under the first-byte limit, when it has one: the clock runs until the try says its reply began, stands still
   * while the try waits for the Host's own permit, and ends the try's own signal when the time is up.
   */
  private async timed<T, R>(
    index: number,
    limitMs: number | undefined,
    input: DispatchInput<T, R>,
    waited: (ms: number) => void,
  ): Promise<AttemptResult<T, R>> {
    const { clock } = this
    const limit = new AbortController()
    let left = limitMs
    let tick: AbortController | undefined
    let since = 0
    let pauses = 0
    let over = false
    let expire: () => void = () => {}
    const expired = new Promise<typeof TIMEOUT>(resolve => {
      expire = () => resolve(TIMEOUT)
    })
    const run = () => {
      if (left === undefined || over || pauses > 0 || tick) return
      const ticking = (tick = new AbortController())
      since = clock.now()
      clock.sleep(left, ticking.signal).then(
        () => {
          if (tick === ticking) expire()
        },
        () => {},
      )
    }
    const stop = () => {
      if (!tick) return
      tick.abort()
      tick = undefined
      if (left !== undefined) left = Math.max(0, left - (clock.now() - since))
    }
    const timer: AttemptTimer = {
      began: () => {
        stop()
        left = undefined
      },
      waiting: async wait => {
        pauses++
        stop()
        const from = clock.now()
        try {
          return await wait
        } finally {
          waited(clock.now() - from)
          pauses--
          run()
        }
      },
    }
    run()
    // The attempt's own signal ends only when its time is up: a reply that began goes on being read under it.
    const attempt = input.attempt(index, AbortSignal.any([input.signal, limit.signal]), timer)
    try {
      const result = await Promise.race<AttemptResult<T, R> | typeof TIMEOUT>([attempt, expired])
      if (result !== TIMEOUT) return result
      // The attempt's late answer is nobody's: whatever it opened ends with its signal.
      attempt.catch(() => {})
      limit.abort(new AppError(504, 'gateway-timeout', '模型服务没有在时限内开始回复'))
      return { ok: false, class: 'timeout', reply: input.timedOut(index) }
    } catch (error) {
      limit.abort(error)
      throw error
    } finally {
      over = true
      stop()
    }
  }

  /** Bound to other settings than the service has now: its key, address or models changed since. */
  private stale(candidate: ScheduledCandidate): boolean {
    const current = this.deps.fingerprint?.(candidate.providerId)
    return this.deps.fingerprint !== undefined && current !== candidate.fingerprint
  }

  /** Candidates in the order they are tried: the turn's own first, services passed over for now last, stale ones never. */
  private order(candidates: readonly ScheduledCandidate[], start?: number): number[] {
    const indexes = candidates.flatMap((candidate, index) => (this.stale(candidate) ? [] : [index]))
    const now = this.clock.now()
    const held = (index: number) => {
      const state = this.state(candidates[index]!.providerId, candidates[index]!.fingerprint)
      return (
        (state.keyInvalidUntil !== undefined && now < state.keyInvalidUntil)
        || (state.restUntil !== undefined && now < state.restUntil)
        || (state.rateUntil !== undefined && now < state.rateUntil)
        || this.gate(candidates[index]!) === 'open'
      )
    }
    const sticky = start !== undefined && start > 0 && indexes.includes(start) && !held(start) ? [start] : []
    const rest = indexes.filter(index => !sticky.includes(index))
    return [...sticky, ...rest.filter(index => !held(index)), ...rest.filter(held)]
  }

  /** Why the first candidate is not tried first. */
  private heldFor(candidate: ScheduledCandidate): ModelFailureClass {
    const state = this.state(candidate.providerId, candidate.fingerprint)
    const now = this.clock.now()
    return state.keyInvalidUntil !== undefined && now < state.keyInvalidUntil
      ? 'auth'
      : state.restUntil !== undefined && now < state.restUntil
        ? 'quota'
        : state.rateUntil !== undefined && now < state.rateUntil
          ? 'rate'
          : 'circuit-open'
  }

  /**
   * What is known of a service, under the settings it has now: another key, address or model list is another service as
   * far as its failures go. Only the service's own current settings start it afresh, never what a candidate was bound to.
   */
  private state(providerId: string, bound?: string): ServiceState {
    const current = this.deps.fingerprint ? (this.deps.fingerprint(providerId) ?? '') : bound
    let state = this.services.get(providerId)
    if (state && current !== undefined && state.fingerprint !== current) {
      const before = this.health(providerId)?.state
      Object.assign(state, this.fresh(current), { active: state.active, waiting: state.waiting })
      if (before) this.deps.changed?.(providerId)
    }
    if (!state) this.services.set(providerId, (state = this.fresh(current ?? '')))
    return state
  }

  private fresh(fingerprint: string): ServiceState {
    // Each optional field is named, so that starting afresh clears what was held against the service.
    return {
      fingerprint,
      consecutive: 0,
      window: [],
      openedAt: undefined,
      trial: false,
      keyInvalidUntil: undefined,
      restStep: 0,
      restUntil: undefined,
      rateUntil: undefined,
      last: undefined,
      firstByte: [],
      active: 0,
      waiting: [],
    }
  }

  /** Whether a request may go to the service: as usual, as the one trial after a pause, or not for now. */
  private gate(candidate: ScheduledCandidate): 'closed' | 'trial' | 'open' {
    const state = this.state(candidate.providerId, candidate.fingerprint)
    if (state.openedAt === undefined) return 'closed'
    if (state.trial || this.clock.now() - state.openedAt < SCHEDULE.breaker.openMs) return 'open'
    return 'trial'
  }

  private succeeded(providerId: string, state: ServiceState): void {
    const before = this.health(providerId)?.state
    state.consecutive = 0
    state.window.push({ at: this.clock.now(), failed: false })
    state.openedAt = undefined
    state.keyInvalidUntil = undefined
    state.restStep = 0
    state.restUntil = undefined
    state.rateUntil = undefined
    this.trim(state)
    if (before !== this.health(providerId)?.state) this.deps.changed?.(providerId)
  }

  /** A trial request began to answer: the service takes requests again. How the reply ends is counted like any other's. */
  private reopened(providerId: string, state: ServiceState): void {
    const before = this.health(providerId)?.state
    state.trial = false
    state.openedAt = undefined
    state.consecutive = 0
    if (before !== this.health(providerId)?.state) this.deps.changed?.(providerId)
  }

  private failed(providerId: string, state: ServiceState, reason: ModelFailureClass, retryAfter?: number): void {
    const before = this.health(providerId)?.state
    const now = this.clock.now()
    state.last = { class: reason, at: now }
    // A limit or a spent balance is the account's state, not a service that fails: each has its own word and its own
    // time, and neither opens the breaker.
    if (reason === 'rate' || reason === 'quota') {
      if (reason === 'rate') state.rateUntil = now + Math.min(retryAfter ?? SCHEDULE.breaker.openMs, SCHEDULE.breaker.openMs)
      else if (state.restUntil === undefined || now >= state.restUntil) {
        // One step per rest, not per failure: requests already under way when the balance ran out take the same step.
        state.restUntil = now + SCHEDULE.restMs[Math.min(state.restStep, SCHEDULE.restMs.length - 1)]!
        state.restStep++
      }
      if (before !== this.health(providerId)?.state) this.deps.changed?.(providerId)
      return
    }
    state.consecutive++
    state.window.push({ at: now, failed: true })
    this.trim(state)
    // Held for as long as a failing service is, then asked again by a real request: a key fixed at the service shows.
    if (reason === 'auth') state.keyInvalidUntil = now + SCHEDULE.breaker.openMs
    const failures = state.window.filter(entry => entry.failed).length
    const { breaker } = SCHEDULE
    // A failed trial, or enough failures: nothing more goes to it for a minute.
    if (
      state.openedAt !== undefined
      || state.consecutive >= breaker.consecutive
      || (state.window.length >= breaker.windowRequests && failures * 2 >= state.window.length)
    )
      state.openedAt = now
    if (before !== this.health(providerId)?.state) this.deps.changed?.(providerId)
  }

  private trim(state: ServiceState): void {
    const from = this.clock.now() - SCHEDULE.breaker.windowMs
    while (state.window.length && (state.window[0]!.at < from || state.window.length > 256)) state.window.shift()
  }

  private firstByte(providerId: string, state: ServiceState, ms: number): void {
    const before = this.slow(state)
    state.firstByte.push(ms)
    if (state.firstByte.length > 60) state.firstByte.shift()
    if (before !== this.slow(state)) this.deps.changed?.(providerId)
  }

  /** The latest five first bytes took three times what the ones before them did. */
  private slow(state: ServiceState): boolean {
    if (state.firstByte.length < 15) return false
    const usual = median(state.firstByte.slice(0, -5))
    return usual > 0 && median(state.firstByte.slice(-5)) >= 3 * usual
  }

  /** A place among the service's requests at a time, waited for in order; at once when it has no limit. */
  private async slot(providerId: string, state: ServiceState, sessionId: string, signal: AbortSignal): Promise<() => void> {
    const take = () => {
      state.active++
      let held = true
      return () => {
        if (!held) return
        held = false
        state.active--
        const limit = this.deps.limit?.(providerId)
        while (state.waiting.length && (limit === undefined || state.active < limit)) state.waiting.shift()!.admit()
      }
    }
    signal.throwIfAborted()
    const limit = this.deps.limit?.(providerId)
    if (limit === undefined || (state.active < limit && state.waiting.length === 0)) return take()
    const stopWaiting = this.waiting(sessionId, providerId)
    const controller = new AbortController()
    try {
      return await new Promise<() => void>((resolve, reject) => {
        const waiter: Waiter = { sessionId, admit: () => resolve(take()) }
        const leave = (reason: unknown) => {
          const at = state.waiting.indexOf(waiter)
          if (at < 0) return
          state.waiting.splice(at, 1)
          reject(reason as Error)
        }
        state.waiting.push(waiter)
        signal.addEventListener('abort', () => leave(signal.reason), { once: true, signal: controller.signal })
        this.clock.sleep(SCHEDULE.slotWaitMs, controller.signal).then(
          () => leave(new AppError(429, 'gateway-busy', '模型请求正在排队，请稍后重试。')),
          () => {},
        )
      })
    } finally {
      controller.abort()
      stopWaiting()
    }
  }
}
