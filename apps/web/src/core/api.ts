import { MODEL_EFFORT, NOT_ACCEPTED_5XX, isFileMention, type FileMention } from '@latch/protocol'
import { isAttachmentRef, type AttachmentRef, type AttachmentUpload } from '@latch/protocol'
import type { ApiFailure, ModelRef, TaskMode, WorktreeStart } from '@latch/protocol'
import { describeFailure } from './securityCopy.ts'
import { readStorage } from './storageKeys.ts'

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
    super('请求超时；Mac 可能仍在处理，请同步状态后确认结果。')
    this.name = 'ApiTimeoutError'
  }
}

/**
 * A request that got no answer at all: fetch itself failed (the Host stopped, the network is down, or the desktop app's
 * proxy gave up on the connection). Unlike a bug in the page, this really is the connection.
 */
export class NoAnswerError extends Error {
  constructor(options?: ErrorOptions) {
    super('No answer', options)
    this.name = 'NoAnswerError'
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
 * Text written for the person, thrown by the page itself (a refusal, an invalid answer, a dialog's own reason): shown as
 * it is, never as 「页面出错了」. Whether a write behind it ran stays as unknown as for any error that is not the Host's.
 * `pnpm lint` keeps `new Error` in apps/web/src to ASCII literals (scripts/oxlint-rules.ts).
 */
export class MessageError extends ClientError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'message', { definitive: false })
    this.name = 'MessageError'
    if (options && 'cause' in options) this.cause = options.cause
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
  /** Reads the headers of a 2xx response, for example `x-latch-audit` on a change that lowered permissions. */
  onHeaders?: (headers: Headers) => void
  /** Adjudicated file bytes use the same authentication, abort and renewal path as JSON. */
  response?: 'bytes'
  range?: { start: number; end?: number }
  ifMatch?: string
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
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.confirmation !== undefined) headers['x-latch-confirmation'] = options.confirmation
  if (options.range) headers.Range = `bytes=${options.range.start}-${options.range.end ?? ''}`
  if (options.ifMatch) headers['if-match'] = options.ifMatch
  // Checked before anything is sent, so what the page got wrong (a header that is not Latin-1, a body that cannot be
  // serialised) throws here as the page's own error, never as a request without an answer.
  // The constructor rejects any value fetch would, before anything is sent.
  // oxlint-disable-next-line no-new
  new Headers(headers)
  const init: RequestInit = {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: controller.signal,
  }
  const forwardAbort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) forwardAbort()
  else options.signal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new ApiTimeoutError()), options.timeoutMs ?? 15_000)
  let failure: ApiError | undefined
  // A throw from the caller's own onHeaders is the page's, not the connection's.
  let inCaller = false
  try {
    const response = await fetch(`/link/api/${path}`, init)
    if (!response.ok) failure = await failureOf(response)
    else {
      inCaller = true
      options.onHeaders?.(response.headers)
      inCaller = false
      if (response.status === 204 || options.discardBody) {
        void response.body?.cancel().catch(() => {})
        return undefined as T
      }
      return (options.response === 'bytes' ? await response.arrayBuffer() : await response.json()) as T
    }
  } catch (error) {
    if (controller.signal.reason instanceof ApiTimeoutError) throw controller.signal.reason
    // fetch, and reading a body, reject with a TypeError only for the network; the request or its answer never arrived.
    if (error instanceof TypeError && !controller.signal.aborted && !inCaller) throw new NoAnswerError({ cause: error })
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

/** Raw upload keeps file bytes out of JSON; every retry carries the same immutable Blob and requestId. */
export async function uploadAttachment(
  file: Blob,
  metadata: AttachmentUpload,
  options: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void; retried?: boolean } = {},
): Promise<AttachmentRef> {
  if (metadata.size !== file.size || file.size <= 0 || file.size > 25 * 1024 * 1024)
    throw new ClientError('附件大小不可用。', 'attachment-too-large')
  const bytes = new TextEncoder().encode(JSON.stringify(metadata)),
    header = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/u, '')
  if (header.length > 4096) throw new ClientError('附件元数据过长。', 'attachment-invalid')
  const response = await new Promise<Response>((resolve, reject) => {
    const xhr = new XMLHttpRequest(),
      abort = () => xhr.abort()
    const cleanup = () => options.signal?.removeEventListener('abort', abort)
    xhr.open('POST', '/link/api/attachments')
    xhr.withCredentials = true
    xhr.timeout = 60_000
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.setRequestHeader('x-latch-attachment', header)
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) options.onProgress?.(Math.min(event.loaded, file.size), file.size)
    }
    xhr.onload = () => {
      cleanup()
      if (xhr.status < 200 || xhr.status > 599 || xhr.responseText.length > 65_536) {
        reject(new ClientError('附件上传响应无效，请重试。', 'attachment-response', { definitive: false }))
        return
      }
      resolve(new Response(xhr.responseText, { status: xhr.status, headers: { 'content-type': 'application/json' } }))
    }
    xhr.onerror = () => {
      cleanup()
      reject(new ClientError('附件上传连接中断，请重试。', 'attachment-upload', { definitive: false }))
    }
    xhr.ontimeout = () => {
      cleanup()
      reject(new ApiTimeoutError())
    }
    xhr.onabort = () => {
      cleanup()
      reject(new DOMException('上传已取消', 'AbortError'))
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) {
      cleanup()
      reject(new DOMException('上传已取消', 'AbortError'))
      return
    }
    xhr.send(file)
  })
  if (response.ok) {
    const value = (await response.json()) as { attachment?: unknown }
    if (!isAttachmentRef(value.attachment)) throw new ClientError('附件上传响应无效。', 'attachment-response', { definitive: false })
    return value.attachment
  }
  const failure = await failureOf(response)
  if (
    !options.retried
    && !options.signal?.aborted
    && ((failure.status === 409 && failure.code === 'upload-retry')
      || (failure.status === 401 && failure.code === 'renewal-required' && (await authHooks.renew?.().catch(() => false))))
  )
    return uploadAttachment(file, metadata, { ...options, retried: true })
  if (failure.status === 401 && failure.code !== 'renewal-required') authHooks.unauthorized?.(failure)
  throw failure
}

export function fileBytes(
  handle: string,
  start?: number,
  end?: number,
  signal?: AbortSignal,
  etag?: string,
  source?: 'attachment',
): Promise<ArrayBuffer> {
  if (
    !/^[A-Za-z0-9_-]{22}$/u.test(handle)
    || (start !== undefined && (!Number.isSafeInteger(start) || start < 0))
    || (end !== undefined && (!Number.isSafeInteger(end) || end < (start ?? 0)))
  )
    return Promise.reject(new ClientError('文件读取范围不可用。', 'file-range'))
  return api<ArrayBuffer>(source === 'attachment' ? `attachments/${handle}/content` : `files/${handle}`, {
    response: 'bytes',
    ...(etag && /^"[a-f0-9]{32}"$/u.test(etag) ? { ifMatch: etag } : {}),
    timeoutMs: 60_000,
    ...(start !== undefined || end !== undefined ? { range: { start: start ?? 0, ...(end === undefined ? {} : { end }) } } : {}),
    ...(signal ? { signal } : {}),
  })
}

/** The computer the page talks to, as `computerLabel` names it; the shell sets it once the snapshot says. */
let computer = 'Mac'
export function setErrorComputer(label: string): void {
  computer = label
}

const logged = new WeakSet<object>()

/**
 * What a failure says, never blaming the network for anything but a request without an answer: the Host's and the
 * page's own messages as they are, 「连不上 … 上的 Latch」 for no answer, and for anything else (a bug in this page)
 * its name, with the stack in the console, since nothing is reported anywhere.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof ApiTimeoutError || error instanceof ClientError) return error.message
  if (error instanceof NoAnswerError) return `连不上 ${computer} 上的 Latch`
  const name = error instanceof Error || error instanceof DOMException ? error.name : ''
  if (name === 'ClipboardError') return (error as Error).message
  if (name === 'AbortError') return '已取消'
  if (error !== null && typeof error === 'object' && !logged.has(error)) {
    logged.add(error)
    console.error('[Latch] 页面出错', error)
  } else if (error === null || typeof error !== 'object') console.error('[Latch] 页面出错', error)
  return `页面出错了（${/^[A-Za-z][A-Za-z0-9_]{0,39}$/u.test(name) ? name : 'Error'}）· 刷新`
}

/**
 * A change that reduces permissions still applies when the Host cannot write its audit log; the Host then answers
 * `x-latch-audit: failed`, and the page says so with the catalog text.
 */
export const auditFailed = (headers: Headers) => headers.get('x-latch-audit') === 'failed'

/** Inline text for a failure, or '' when the message is already shown elsewhere (the confirmation dialog). */
export function inlineError(error: unknown): string {
  return error instanceof ClientError && error.handled ? '' : errorMessage(error)
}

/**
 * A write whose outcome is unknown: retry it with the same requestId instead of assuming failure. A 5xx whose code says
 * the Host accepted nothing (`NOT_ACCEPTED_5XX`, such as a Harness that could not start) is a definite failure.
 */
export function isUncertain(error: unknown): boolean {
  if (error instanceof ClientError) return !error.definitive
  if (!(error instanceof ApiError)) return true
  return error.status === 408 || (error.status >= 500 && !NOT_ACCEPTED_5XX.has(error.code))
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
  forkOf?: { taskId: string; upToMessageId: string }
  queue?: true
  /** Into the running turn when its harness takes that, queued otherwise. */
  steer?: true
  /** This turn starts a new context in the session. */
  freshContext?: true
  fileRefs?: FileMention[]
  attachmentIds?: string[]
  /** A new session's picks from the Harness's own options. */
  config?: Array<{ configId: string; value: string }>
  /** A new session on the Harness's own default model, chosen as such: the project's 默认模型 does not replace it. */
  ownModel?: true
  /** A new session starts in a worktree of its project: `true` from the folder's HEAD, or another start point. */
  worktree?: true | WorktreeStart
  /** A new session of one of 我的 Agent (a delegation); the Host fills what the request leaves out from the Agent. */
  customAgentId?: string
  /** An earlier prompt sent again (重试): it never came from the input, so delivering it leaves the session's draft. */
  resent?: true
}

/** The submission took the input's text, attachments and file references; a prompt sent again (`resent`) took none. */
export const fromInput = (submission: Pick<PendingSubmission, 'resent'>): boolean => submission.resent !== true

/** A stored start point, as the Host accepts it; anything else is dropped. */
export function worktreeStartOf(value: unknown): true | WorktreeStart | undefined {
  if (value === true) return true
  if (typeof value !== 'object' || value === null) return undefined
  const item = value as Record<string, unknown>
  const text = (field: unknown) => typeof field === 'string' && field.length > 0 && field.length <= 200
  if (item.from === 'head') return { from: 'head' }
  if (item.from === 'commit' && text(item.ref)) return { from: 'commit', ref: item.ref as string }
  if (item.from === 'branch' && text(item.branch)) return { from: 'branch', branch: item.branch as string }
  if (item.from === 'reuse' && typeof item.name === 'string' && /^\d{8}-[0-9a-f]{4}$/u.test(item.name))
    return { from: 'reuse', name: item.name }
  return undefined
}

function modelRef(value: unknown): ModelRef | undefined {
  if (typeof value !== 'object' || value === null) return
  const item = value as Record<string, unknown>
  return typeof item.providerId === 'string' && typeof item.model === 'string'
    ? {
        providerId: item.providerId,
        model: item.model,
        ...(typeof item.effort === 'string' && MODEL_EFFORT.test(item.effort) ? { effort: item.effort } : {}),
      }
    : undefined
}

export function readPending(key: string): PendingSubmission | null {
  try {
    const value: unknown = JSON.parse(readStorage('localStorage', key) ?? 'null')
    if (typeof value !== 'object' || value === null) return null
    const item = value as Record<string, unknown>
    if (typeof item.requestId !== 'string' || typeof item.prompt !== 'string') return null
    // An assistant's message cannot be sent again: sent without it, it would start an ordinary session.
    if (item.assistantId !== undefined) return null
    for (const field of ['sessionId', 'harnessId', 'workspaceId', 'customAgentId'] as const)
      if (item[field] !== undefined && typeof item[field] !== 'string') return null
    if (item.mode !== undefined && item.mode !== 'chat' && item.mode !== 'agent') return null
    if (item.model !== undefined && modelRef(item.model) === undefined) return null
    if (item.queue !== undefined && item.queue !== true) return null
    if (item.steer !== undefined && item.steer !== true) return null
    if (item.resent !== undefined && (item.resent !== true || typeof item.sessionId !== 'string')) return null
    if (item.freshContext !== undefined && (item.freshContext !== true || typeof item.sessionId !== 'string')) return null
    if (item.worktree !== undefined && (worktreeStartOf(item.worktree) === undefined || item.sessionId !== undefined)) return null
    const fork = item.forkOf as { taskId?: unknown; upToMessageId?: unknown } | undefined
    if (fork !== undefined && (!fork || typeof fork.taskId !== 'string' || typeof fork.upToMessageId !== 'string')) return null
    if (
      item.attachmentIds !== undefined
      && (!Array.isArray(item.attachmentIds)
        || item.attachmentIds.length > 8
        || !item.attachmentIds.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{22}$/u.test(id)))
    )
      return null
    if (item.fileRefs !== undefined && (!Array.isArray(item.fileRefs) || item.fileRefs.length > 32 || !item.fileRefs.every(isFileMention)))
      return null
    if (
      item.config !== undefined
      && (!Array.isArray(item.config)
        || item.config.length > 16
        || !item.config.every(
          (pick: unknown) =>
            typeof pick === 'object'
            && pick !== null
            && typeof (pick as Record<string, unknown>).configId === 'string'
            && typeof (pick as Record<string, unknown>).value === 'string',
        ))
    )
      return null
    const model = modelRef(item.model)
    return {
      requestId: item.requestId,
      prompt: item.prompt,
      ...(typeof item.sessionId === 'string' ? { sessionId: item.sessionId } : {}),
      ...(item.mode === 'chat' || item.mode === 'agent' ? { mode: item.mode } : {}),
      ...(typeof item.harnessId === 'string' ? { harnessId: item.harnessId } : {}),
      ...(typeof item.workspaceId === 'string' ? { workspaceId: item.workspaceId } : {}),
      ...(typeof item.customAgentId === 'string' && item.sessionId === undefined ? { customAgentId: item.customAgentId } : {}),
      ...(model ? { model } : {}),
      ...(item.queue === true ? { queue: true as const } : {}),
      ...(item.steer === true ? { steer: true as const } : {}),
      ...(item.resent === true ? { resent: true as const } : {}),
      ...(item.freshContext === true ? { freshContext: true as const } : {}),
      ...(item.ownModel === true && item.sessionId === undefined ? { ownModel: true as const } : {}),
      ...(worktreeStartOf(item.worktree) ? { worktree: worktreeStartOf(item.worktree)! } : {}),
      ...(fork ? { forkOf: { taskId: fork.taskId as string, upToMessageId: fork.upToMessageId as string } } : {}),
      ...(Array.isArray(item.fileRefs) ? { fileRefs: item.fileRefs as FileMention[] } : {}),
      ...(Array.isArray(item.attachmentIds) ? { attachmentIds: item.attachmentIds as string[] } : {}),
      ...(Array.isArray(item.config)
        ? { config: (item.config as Array<{ configId: string; value: string }>).map(({ configId, value }) => ({ configId, value })) }
        : {}),
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
  const attachments = {
    ...(submission.attachmentIds?.length ? { attachmentIds: submission.attachmentIds } : {}),
    ...(submission.fileRefs?.length ? { fileRefs: submission.fileRefs } : {}),
  }
  if (submission.sessionId !== undefined) {
    return {
      path: `tasks/${encodeURIComponent(submission.sessionId)}/prompt`,
      body: {
        prompt,
        requestId,
        ...(model ? { model } : {}),
        ...(submission.queue ? { queue: true } : {}),
        ...(submission.steer ? { steer: true } : {}),
        ...(submission.freshContext ? { freshContext: true } : {}),
        ...attachments,
      },
    }
  }
  return {
    path: 'tasks',
    body: {
      prompt,
      requestId,
      mode: submission.mode ?? 'agent',
      ...attachments,
      ...(submission.harnessId ? { harnessId: submission.harnessId } : {}),
      ...(model ? { model } : {}),
      ...(submission.workspaceId ? { workspaceId: submission.workspaceId } : {}),
      ...(submission.forkOf ? { forkOf: submission.forkOf } : {}),
      ...(submission.config?.length ? { config: submission.config } : {}),
      ...(submission.ownModel && !model ? { ownModel: true } : {}),
      ...(submission.worktree ? { worktree: submission.worktree } : {}),
      ...(submission.customAgentId ? { customAgentId: submission.customAgentId } : {}),
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
