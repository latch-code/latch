import type { IncomingMessage } from 'node:http'
import { SCOPE_LABELS, type ConfirmationTicket, type DeviceScope, type ListenerClass, type PermissionLevel } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import type { ListenerContext } from './listeners.ts'

/** Credential as presented on the wire; the device store decides what it is worth. */
export type Presented = { kind: 'cookie' | 'header'; value: string } | { kind: 'legacy-cookie'; value: string }

export const LEGACY_COOKIE = 'harness_link'
const CREDENTIAL_HEADER = /^Latch-Device ([!-~]{1,256})$/u

/**
 * host.sock is not a browser transport: it has no cookies, Host header or Origin, the credential travels in the
 * authorization header and comes back in JSON. This decides the wire format only; whether a caller counts as this
 * computer is `isLocalListener`.
 */
export function isSocketTransport(listener: ListenerClass): boolean {
  return listener === 'unix'
}

export function cookieName(listener: ListenerClass, hostId8: string): string {
  return listener === 'loopback-tcp' ? `latch_${hostId8}` : `__Host-latch_${hostId8}`
}

/** Every value of one cookie name; a request may carry the same name more than once. */
export function cookieValues(header: string | undefined, name: string): string[] {
  if (!header) return []
  const values: string[] = []
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) values.push(part.slice(index + 1).trim())
  }
  return values
}

/**
 * TCP listeners read only their own cookie, unix only the authorization header; the other form is
 * ignored. Two cookies with the same name count as none. The legacy cookie is read on loopback only,
 * and only when no new-style cookie is present.
 */
export function presentedCredential(req: IncomingMessage, listener: ListenerContext, hostId8: string): Presented | undefined {
  if (isSocketTransport(listener.listener)) {
    const header = req.headers.authorization
    if (typeof header !== 'string') return undefined
    const match = CREDENTIAL_HEADER.exec(header.trim())
    return match ? { kind: 'header', value: match[1]! } : { kind: 'header', value: '' }
  }
  const current = cookieValues(req.headers.cookie, cookieName(listener.listener, hostId8))
  if (current.length === 1) return { kind: 'cookie', value: current[0]! }
  if (current.length > 1) return undefined
  if (listener.listener !== 'loopback-tcp') return undefined
  const legacy = cookieValues(req.headers.cookie, LEGACY_COOKIE)
  return legacy.length === 1 ? { kind: 'legacy-cookie', value: legacy[0]! } : undefined
}

export function hasAuthorization(req: IncomingMessage): boolean {
  return typeof req.headers.authorization === 'string'
}

export function credentialCookie(listener: ListenerClass, hostId8: string, credential: string, expiresAt: number, now: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000))
  const name = cookieName(listener, hostId8)
  return listener === 'loopback-tcp'
    ? `${name}=${credential}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`
    : `${name}=${credential}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`
}

export function clearedCredentialCookie(listener: ListenerClass, hostId8: string): string {
  const name = cookieName(listener, hostId8)
  return listener === 'loopback-tcp'
    ? `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
    : `${name}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
}

export const CLEARED_LEGACY_COOKIE = `${LEGACY_COOKIE}=; Path=/link; Max-Age=0; HttpOnly; SameSite=Strict`

const AUTH_FAILURES = {
  unauthorized: [401, '请先在本机确认这台设备'],
  'renewal-required': [401, '设备凭据需要续期'],
  'credential-expired': [401, '此设备的登记已满 30 天，请重新在本机确认'],
  'device-revoked': [401, '此设备已被撤销，请重新在本机确认'],
  'listener-mismatch': [401, '此设备凭据不能在当前地址使用，请重新在本机确认'],
  'legacy-reconfirm': [401, '此设备需要在本机重新确认'],
  'credential-rotated': [409, '凭据已在其他页面续期，请刷新'],
} as const satisfies Record<string, readonly [number, string]>
export type AuthFailureCode = keyof typeof AUTH_FAILURES

export function authFailure(code: AuthFailureCode, details?: Record<string, unknown>): AppError {
  const [status, message] = AUTH_FAILURES[code]
  return new AppError(status, code, message, details)
}

export function scopeRequired(scope: DeviceScope): AppError {
  return new AppError(403, 'scope-required', `此设备没有「${SCOPE_LABELS[scope]}」权限`, { required: scope })
}

export function localOnly(): AppError {
  return new AppError(403, 'local-only', '此操作只能在执行端电脑上用 Latch 桌面端进行')
}

export function ceilingExceeded(allowed: PermissionLevel[]): AppError {
  return new AppError(403, 'ceiling-exceeded', '超出此设备可用的权限上限', { allowed })
}

export function hostDesktopRequired(): AppError {
  return new AppError(403, 'stepup-required', '高风险操作只能在执行端电脑上用 Latch 桌面端确认', { stepup: { where: 'host-desktop' } })
}

export function stepupRequired(confirmation: ConfirmationTicket): AppError {
  return new AppError(403, 'stepup-required', '需要在本机确认', { stepup: { where: 'this-device' }, confirmation })
}

const LEVELS: PermissionLevel[] = ['L0', 'L1', 'L2', 'L3']
export function levelAtMost(level: PermissionLevel, ceiling: PermissionLevel): boolean {
  return LEVELS.indexOf(level) <= LEVELS.indexOf(ceiling)
}

/** Levels up to and including the ceiling, for `ceiling-exceeded` details. */
export function levelsUpTo(ceiling: PermissionLevel): PermissionLevel[] {
  return LEVELS.slice(0, LEVELS.indexOf(ceiling) + 1)
}

/** Only the public ticket fields leave the Host. */
export function publicTicket(record: ConfirmationTicket): ConfirmationTicket {
  return {
    id: record.id,
    action: record.action,
    title: record.title,
    status: record.status,
    hashDisplay: record.hashDisplay,
    expiresAt: record.expiresAt,
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
    ...(record.form !== undefined ? { form: record.form } : {}),
    ...(record.lines ? { lines: record.lines.map(line => ({ label: line.label, value: line.value })) } : {}),
    ...(record.warnings ? { warnings: [...record.warnings] } : {}),
    ...(record.failure !== undefined ? { failure: record.failure } : {}),
  }
}

// ---- Rate limits -----------------------------------------------------------------------------

export interface BucketSpec {
  capacity: number
  refill: number
  perMs: number
}

export const RATE_LIMITS = {
  authFailure: { capacity: 100, refill: 20, perMs: 1_000 },
  enrollmentCreate: { capacity: 3, refill: 1, perMs: 20_000 },
  enrollmentPoll: { capacity: 5, refill: 2, perMs: 1_000 },
  classC: { capacity: 60, refill: 1, perMs: 1_000 },
  anonymousRevoke: { capacity: 10, refill: 1, perMs: 6_000 },
  confirmationPoll: { capacity: 5, refill: 2, perMs: 1_000 },
  /** The desktop app's file routes, per device. */
  files: { capacity: 60, refill: 20, perMs: 1_000 },
} as const satisfies Record<string, BucketSpec>
export type BucketName = keyof typeof RATE_LIMITS

const MAX_KEYS = 10_000

/** In-memory token buckets keyed by device, enrollment, confirmation or listener class. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  private readonly capacity: number
  private readonly rate: number

  constructor(
    spec: BucketSpec,
    factor: number,
    private readonly now: () => number,
  ) {
    this.capacity = spec.capacity * factor
    this.rate = (spec.refill * factor) / spec.perMs
  }

  /** Takes one token or throws `429 rate-limited` with `retryAfter` seconds. */
  take(key = ''): void {
    const now = this.now()
    let bucket = this.buckets.get(key)
    if (!bucket) {
      if (this.buckets.size >= MAX_KEYS) this.prune(now)
      bucket = { tokens: this.capacity, at: now }
      this.buckets.set(key, bucket)
    }
    bucket.tokens = Math.min(this.capacity, bucket.tokens + Math.max(0, now - bucket.at) * this.rate)
    bucket.at = now
    if (bucket.tokens < 1) {
      const retryAfter = Math.max(1, Math.ceil((1 - bucket.tokens) / this.rate / 1000))
      throw new AppError(429, 'rate-limited', '请求过于频繁，请稍后再试', { retryAfter })
    }
    bucket.tokens -= 1
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + (now - bucket.at) * this.rate >= this.capacity) this.buckets.delete(key)
    }
    // Still full of active keys: forget the oldest rather than grow without bound.
    while (this.buckets.size >= MAX_KEYS) this.buckets.delete(this.buckets.keys().next().value!)
  }
}

export function createRateLimits(mode: 'default' | 'relaxed', now: () => number): Record<BucketName, RateLimiter> {
  const factor = mode === 'relaxed' ? 100 : 1
  return Object.fromEntries(Object.entries(RATE_LIMITS).map(([name, spec]) => [name, new RateLimiter(spec, factor, now)])) as Record<
    BucketName,
    RateLimiter
  >
}
