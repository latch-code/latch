import type { AppSnapshot, EnrollmentInfo } from '@latch/protocol'
import { api as defaultApi, ApiError, ClientError, type ApiOptions } from './api.ts'
import { loadDeviceKey, renewSigningText, signText, type DeviceKeyRecord } from './deviceKey.ts'
import { ENROLLMENT_REASON_TEXT, type EnrollmentReason } from './securityCopy.ts'

/** The stored key is gone (cleared site data, another browser profile): only a new enrollment helps. */
export class MissingDeviceKeyError extends ClientError {
  constructor() {
    super(ENROLLMENT_REASON_TEXT['key-missing']!, 'key-missing')
  }
}

/** The Host drops a renewed credential that is not presented within 10 minutes. */
export const PENDING_WINDOW_MS = 10 * 60_000
/**
 * A credential renewed here is not due again for a day, so the Host asking for renewal again within this time means the
 * browser still presents the credential it replaced.
 */
const NOT_KEPT_WINDOW_MS = 60 * 60_000

/**
 * A renewal succeeded, but this browser still presents the credential it replaced: it did not store the new cookie
 * (for example, cookies are blocked). No further credential is issued for it. `final`: the Host's pending window has
 * passed, so the renewed credential can no longer be used and the page leaves for the enrollment page.
 */
export class CredentialNotKeptError extends ClientError {
  constructor(readonly final: boolean) {
    super(ENROLLMENT_REASON_TEXT['renewal-not-stored']!, 'renewal-not-stored')
  }
}

export interface RenewalIdentity {
  hostId?: string
  deviceId?: string
}

export interface RenewalDeps {
  api: <T>(path: string, options?: ApiOptions) => Promise<T>
  /** Web Locks; absent only in tests that check the in-tab single flight alone. */
  locks?: Pick<LockManager, 'request'>
  loadKey: (hostId: string) => Promise<DeviceKeyRecord | undefined>
  sign: (key: CryptoKey, text: string) => Promise<string>
  now: () => number
}

const isRotated = (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'credential-rotated'
const isInvalidSignature = (error: unknown) => error instanceof ApiError && error.status === 401 && error.code === 'invalid-signature'

/** `rotated`: another tab renewed first and its credential is already in place, so the page only reloads state. */
export type RenewalResult = 'renewed' | 'not-due' | 'rotated'

/**
 * Credential rotation for browsers. One renewal per tab at a time, and one per
 * Host across tabs (Web Locks); inside the lock the snapshot is read again so a
 * tab that waited behind another one does not rotate a second time.
 *
 * The Host keeps the current credential until the renewed one is first presented, so a renewal whose answer is lost
 * (network error, timeout, 5xx) leaves this browser on a credential that still works: the error is passed on and the
 * caller retries later (see RenewalBackoff). A later renewal replaces the unused one on the Host.
 */
export function createRenewer(deps: RenewalDeps) {
  let inflight: Promise<RenewalResult> | null = null
  /** When this tab's latest renewal succeeded; cleared once the Host no longer asks for renewal. */
  let renewedAt: number | null = null

  async function hostIdOf(identity: RenewalIdentity): Promise<string> {
    if (identity.hostId) return identity.hostId
    const info = await deps.api<EnrollmentInfo>('enrollment-info', { noRenew: true })
    return info.hostId
  }

  async function run(hostId: string, identity: RenewalIdentity): Promise<RenewalResult> {
    try {
      const snapshot = await deps.api<AppSnapshot>('snapshot', { noRenew: true })
      if (Date.parse(snapshot.device.renewAfter) > deps.now()) {
        renewedAt = null
        return 'not-due'
      }
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401 && error.code === 'renewal-required')) throw error
    }
    if (renewedAt !== null) {
      const since = deps.now() - renewedAt
      // Renewing again would issue one credential per trigger and still leave the browser on the old one.
      if (since >= 0 && since < NOT_KEPT_WINDOW_MS) throw new CredentialNotKeptError(since > PENDING_WINDOW_MS)
      renewedAt = null
    }
    const key = await deps.loadKey(hostId)
    if (!key) throw new MissingDeviceKeyError()
    const deviceId = identity.deviceId ?? key.deviceId
    if (!deviceId) throw new MissingDeviceKeyError()
    const result = await rotate(hostId, deviceId, key)
    if (result === 'renewed') renewedAt = deps.now()
    return result
  }

  async function rotate(hostId: string, deviceId: string, key: DeviceKeyRecord): Promise<RenewalResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        const { nonce } = await deps.api<{ nonce: string; expiresAt: string }>('credentials/challenge', {
          method: 'POST',
          body: {},
          noRenew: true,
        })
        const signature = await deps.sign(key.privateKey, renewSigningText(hostId, deviceId, nonce))
        // The new cookie arrives with the response headers, so a 2xx status settles it even if the body is lost.
        await deps.api<unknown>('credentials/renew', { method: 'POST', body: { nonce, signature }, noRenew: true, discardBody: true })
        return 'renewed'
      } catch (error) {
        if (isRotated(error)) return 'rotated'
        // The challenge expired or the Host restarted in between: one fresh challenge decides.
        if (isInvalidSignature(error) && attempt === 0) continue
        throw error
      }
    }
  }

  return {
    renew(identity: RenewalIdentity = {}): Promise<RenewalResult> {
      if (inflight) return inflight
      inflight = (async () => {
        const hostId = await hostIdOf(identity)
        return deps.locks
          ? (deps.locks.request(`latch-renew-${hostId}`, () => run(hostId, identity)) as Promise<RenewalResult>)
          : run(hostId, identity)
      })().finally(() => {
        inflight = null
      })
      return inflight
    },
  }
}

const FIRST_RETRY_MS = 2_000
const MAX_RETRY_MS = 30_000

/**
 * Paces renewal after failures that leave the current credential in place (network, timeout, 5xx, rate limit, a
 * renewed cookie the browser did not store yet). Every trigger inside the wait (a 401 renewal-required from any request
 * or from the event stream) shares it instead of sending its own renewal; the waits double from 2 s to 30 s.
 */
export class RenewalBackoff {
  private failures = 0
  private notBefore = 0
  constructor(private readonly now: () => number = Date.now) {}

  /** Milliseconds until the next attempt may start; 0 when it may start now. */
  wait(): number {
    return Math.max(0, this.notBefore - this.now())
  }

  /** Records a transient failure and returns the wait before the next attempt. */
  failed(): number {
    const delay = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(this.failures, 16))
    this.failures++
    this.notBefore = this.now() + delay
    return delay
  }

  /** The scheduled retry starts: the wait is over even when its timer fired a little early. */
  release(): void {
    this.notBefore = 0
  }

  reset(): void {
    this.failures = 0
    this.notBefore = 0
  }
}

const RENEWAL_401_CODES = new Set<string>(['device-revoked', 'credential-expired', 'listener-mismatch'])

/**
 * What a failed renewal attempt proved: a cause only re-enrollment fixes, or null for a transient failure (network,
 * timeout, 5xx, rate limit, a renewed cookie not stored yet). The Host keeps the current credential until a renewed one
 * is used, so after a transient failure the page keeps that credential, keeps reconnecting and renews again after a
 * backoff.
 */
export function renewalFailureOf(cause: unknown): EnrollmentReason | null {
  if (cause instanceof MissingDeviceKeyError) return 'key-missing'
  if (cause instanceof CredentialNotKeptError) return cause.final ? 'renewal-not-stored' : null
  if (cause instanceof ApiError && cause.status === 401)
    return RENEWAL_401_CODES.has(cause.code) ? (cause.code as EnrollmentReason) : 'unauthorized'
  return null
}

export interface RenewalSchedulerDeps {
  renew: (identity: RenewalIdentity) => Promise<RenewalResult>
  /** The wait after a transient failure is over: renew again and reload state. */
  retry: () => void
  now?: () => number
}

/**
 * The page's renewal attempts. A trigger that arrives while an attempt runs shares it, so a failed attempt counts once
 * for the backoff however many requests were waiting on it. A transient failure schedules one retry; triggers during
 * the wait get false and leave the renewal to that retry.
 */
export class RenewalScheduler {
  /** Why the latest attempt failed, when only re-enrollment fixes it. Each new attempt clears it. */
  failure: EnrollmentReason | null = null
  private attempt: Promise<boolean> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  /** Bumped by `stop`, so an attempt still running then schedules nothing. */
  private generation = 0
  private readonly backoff: RenewalBackoff

  constructor(private readonly deps: RenewalSchedulerDeps) {
    this.backoff = new RenewalBackoff(deps.now)
  }

  /** True when the page should reload state: renewed here or by another tab, or no longer due. */
  renew(identity: RenewalIdentity): Promise<boolean> {
    if (this.attempt) return this.attempt
    this.failure = null
    if (this.backoff.wait() > 0) return Promise.resolve(false)
    const generation = this.generation
    const attempt = this.deps
      .renew(identity)
      .then(
        () => {
          if (generation === this.generation) this.backoff.reset()
          return true
        },
        (cause: unknown) => {
          if (generation !== this.generation) return false
          this.failure = renewalFailureOf(cause)
          if (this.failure === null) {
            clearTimeout(this.timer)
            this.timer = setTimeout(() => {
              this.timer = undefined
              this.backoff.release()
              this.deps.retry()
            }, this.backoff.failed())
          }
          return false
        },
      )
      .finally(() => {
        if (this.attempt === attempt) this.attempt = null
      })
    this.attempt = attempt
    return attempt
  }

  /** Signed out or unmounted: no retry fires later, and a new enrollment starts without a wait. */
  stop(): void {
    this.generation++
    clearTimeout(this.timer)
    this.timer = undefined
    this.backoff.reset()
    this.attempt = null
  }
}

let browserRenewer: ReturnType<typeof createRenewer> | null = null

/** The page-wide renewer bound to the real API, IndexedDB and Web Locks. */
export function browserRenewal(): ReturnType<typeof createRenewer> {
  browserRenewer ??= createRenewer({
    api: defaultApi,
    locks: typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : undefined,
    loadKey: loadDeviceKey,
    sign: (key, text) => signText(key, text),
    now: () => Date.now(),
  })
  return browserRenewer
}
