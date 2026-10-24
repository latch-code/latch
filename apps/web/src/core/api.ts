import type { ApiFailure, ModelRef, TaskMode } from '@latch/protocol'
import { describeFailure } from './securityCopy.ts'

/** An explicit server rejection; network errors remain distinguishable. `details` carries the rest of the error body. */
export class ApiError extends Error {
  readonly details: Readonly<Partial<ApiFailure>>
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    details: Partial<ApiFailure> = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.details = details
  }
}

export class ApiTimeoutError extends Error {
  constructor() {
    super('请求超时；执行端可能仍在处理，请同步状态后确认结果。')
    this.name = 'ApiTimeoutError'
  }
}

/**
 * A failure decided in this page with a message for the user, such as a local
 * confirmation that was denied. `definitive`: the request was not executed.
 * `handled`: the message is already on screen (e.g. in the confirmation dialog).
 */
export class ClientError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly options: { definitive?: boolean; handled?: boolean } = {},
  ) {
    super(message)
    this.name = 'ClientError'
  }
  get definitive(): boolean {
    return this.options.definitive ?? true
  }
  get handled(): boolean {
    return this.options.handled ?? false
  }
}

/**
 * Hooks the session layer installs: `renew` rotates an expiring credential
 * (resolving false when it cannot), `unauthorized` reports any other 401 so the
 * app can return to enrollment even when the failing call was not the snapshot.
 */
export interface AuthHooks {
  renew?: () => Promise<boolean>
  unauthorized?: (error: ApiError) => void
}
const authHooks: AuthHooks = {}
export function setAuthHooks(hooks: AuthHooks): () => void {
  Object.assign(authHooks, hooks)
  return () => {
    if (authHooks.renew === hooks.renew) delete authHooks.renew
    if (authHooks.unauthorized === hooks.unauthorized) delete authHooks.unauthorized
  }
}

export interface ApiOptions {
  method?: string
  body?: object
  signal?: AbortSignal
  timeoutMs?: number
  /** A consumed local confirmation (`x-latch-confirmation`) for a request the Host asked to confirm. */
  confirmation?: string
  /** Renewal requests themselves, and retries after a renewal, must not trigger another renewal. */
  noRenew?: boolean
  /** Internal: the one automatic retry after `429 rate-limited` has been used. */
  rateRetried?: boolean
  /** Only the status matters (a renewal's cookie arrives with the headers), so a 2xx body is not read. */
  discardBody?: boolean
}

const MAX_AUTOMATIC_WAIT_SECONDS = 5
const pause = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })

async function failureOf(response: Response): Promise<ApiError> {
  let failure: Partial<ApiFailure> = {}
  try {
    failure = (await response.json()) as Partial<ApiFailure>
  } catch {
    /* Non-JSON proxy failures use the HTTP status below. */
  }
  const code = typeof failure.error === 'string' ? failure.error : 'request-failed'
  const { error: _code, message: _message, ...details } = failure
  return new ApiError(
    response.status,
    code,
    describeFailure(response.status, code, typeof failure.message === 'string' ? failure.message : '', details),
    details,
  )
}

/** Cookie-authenticated API (the desktop shell adds its own header). Credentials never enter a URL or browser storage. */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) forwardAbort()
  else options.signal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new ApiTimeoutError()), options.timeoutMs ?? 15_000)
  let failure: ApiError | undefined
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    if (options.confirmation !== undefined) headers['x-latch-confirmation'] = options.confirmation
    const response = await fetch(`/link/api/${path}`, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    })
    if (!response.ok) failure = await failureOf(response)
    else if (response.status === 204 || options.discardBody) {
      void response.body?.cancel().catch(() => {})
      return undefined as T
    } else return (await response.json()) as T
  } catch (error) {
    if (controller.signal.reason instanceof ApiTimeoutError) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', forwardAbort)
  }
  if (failure === undefined) throw new Error('unreachable')
  if (failure.status === 401 && failure.code === 'renewal-required' && !options.noRenew && authHooks.renew) {
    if (await authHooks.renew().catch(() => false)) return api<T>(path, { ...options, noRenew: true })
  }
  if (failure.status === 401 && failure.code !== 'renewal-required') authHooks.unauthorized?.(failure)
  // A refused request was not executed, so one automatic retry after a short wait is safe.
  const wait = failure.details.retryAfter
  if (
    failure.status === 429
    && failure.code === 'rate-limited'
    && typeof wait === 'number'
    && wait <= MAX_AUTOMATIC_WAIT_SECONDS
    && !options.signal?.aborted
    && !options.rateRetried
  ) {
    await pause(Math.max(0, wait) * 1000)
    return api<T>(path, { ...options, rateRetried: true })
  }
  throw failure
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError || error instanceof ApiTimeoutError || error instanceof ClientError
    ? error.message
    : '连接暂时不可用，请检查网络后重试。'
}

/** Inline text for a failure, or '' when the message is already shown elsewhere (the confirmation dialog). */
export function inlineError(error: unknown): string {
  return error instanceof ClientError && error.handled ? '' : errorMessage(error)
}

/** Host refusals that arrive as 5xx but state that nothing was executed. */
const REFUSED_5XX = new Set(['audit-unavailable', 'presence-unavailable', 'agent-busy'])

/** A write whose outcome is unknown: retry it with the same requestId instead of assuming failure. */
export function isUncertain(error: unknown): boolean {
  if (error instanceof ClientError) return !error.definitive
  if (error instanceof ApiError && REFUSED_5XX.has(error.code)) return false
  return !(error instanceof ApiError) || error.status >= 500 || error.status === 408
}

/** The exact request a device sent, kept until the Host confirms it so a retry repeats it verbatim. */
export interface PendingSubmission {
  requestId: string
  prompt: string
  sessionId?: string
  mode?: TaskMode
  harnessId?: string
  model?: ModelRef
  workspaceId?: string
}

function modelRef(value: unknown): ModelRef | undefined {
  if (typeof value !== 'object' || value === null) return
  const item = value as Record<string, unknown>
  return typeof item.providerId === 'string' && typeof item.model === 'string'
    ? { providerId: item.providerId, model: item.model }
    : undefined
}

export function readPending(key: string): PendingSubmission | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (typeof value !== 'object' || value === null) return null
    const item = value as Record<string, unknown>
    if (typeof item.requestId !== 'string' || typeof item.prompt !== 'string') return null
    for (const field of ['sessionId', 'harnessId', 'workspaceId'] as const)
      if (item[field] !== undefined && typeof item[field] !== 'string') return null
    if (item.mode !== undefined && item.mode !== 'chat' && item.mode !== 'agent') return null
    if (item.model !== undefined && modelRef(item.model) === undefined) return null
    const model = modelRef(item.model)
    return {
      requestId: item.requestId,
      prompt: item.prompt,
      ...(typeof item.sessionId === 'string' ? { sessionId: item.sessionId } : {}),
      ...(item.mode === 'chat' || item.mode === 'agent' ? { mode: item.mode } : {}),
      ...(typeof item.harnessId === 'string' ? { harnessId: item.harnessId } : {}),
      ...(typeof item.workspaceId === 'string' ? { workspaceId: item.workspaceId } : {}),
      ...(model ? { model } : {}),
    }
  } catch {
    return null
  }
}

export function writePending(key: string, value: PendingSubmission | null): void {
  if (value === null) localStorage.removeItem(key)
  else localStorage.setItem(key, JSON.stringify(value))
}

/** Maps a stored submission to its HTTP request; optional fields are sent only when chosen. */
export function submissionRequest(submission: PendingSubmission): { path: string; body: Record<string, unknown> } {
  const { requestId, prompt, model } = submission
  if (submission.sessionId !== undefined) {
    return { path: `tasks/${encodeURIComponent(submission.sessionId)}/prompt`, body: { prompt, requestId, ...(model ? { model } : {}) } }
  }
  return {
    path: 'tasks',
    body: {
      prompt,
      requestId,
      mode: submission.mode ?? 'agent',
      ...(submission.harnessId ? { harnessId: submission.harnessId } : {}),
      ...(model ? { model } : {}),
      ...(submission.workspaceId ? { workspaceId: submission.workspaceId } : {}),
    },
  }
}

/** Works on a trusted LAN's HTTP origin as well as HTTPS. */
export function newRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
