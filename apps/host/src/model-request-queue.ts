import { AppError } from '@latch/sdk'

interface WaitingRequest {
  bytes: number
  signal: AbortSignal
  abort(): void
  timer: ReturnType<typeof setTimeout>
  resolve(release: () => void): void
  reject(reason: unknown): void
}

/** One Host's upstream permits; a permit belongs to the entire response, not just its headers. */
export class ModelRequestQueue {
  private active = 0
  private queuedBytes = 0
  private readonly waiting = new Set<WaitingRequest>()
  private closed = false

  constructor(private readonly limits = { active: 32, waiting: 128, bytes: 64 * 1024 * 1024, waitMs: 30_000 }) {}

  /** `waiting`: called when the request has to wait, and its result when it waits no longer, admitted or not. */
  async acquire(signal: AbortSignal, bytes: number, waiting?: () => () => void): Promise<() => void> {
    signal.throwIfAborted()
    if (this.closed) throw this.stopped()
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new AppError(400, 'invalid-model-request', '模型请求大小无效。')
    if (this.active < this.limits.active) return this.permit()
    if (this.waiting.size >= this.limits.waiting || bytes > this.limits.bytes - this.queuedBytes) throw this.busy()
    const waited = waiting?.()
    return new Promise<() => void>((resolve, reject) => {
      const remove = (reason: unknown) => {
        if (!this.remove(request)) return
        reject(reason)
      }
      const request: WaitingRequest = {
        bytes,
        signal,
        resolve,
        reject,
        abort: () => remove(signal.reason),
        timer: setTimeout(() => remove(this.busy()), this.limits.waitMs),
      }
      request.timer.unref()
      this.waiting.add(request)
      this.queuedBytes += bytes
      signal.addEventListener('abort', request.abort, { once: true })
    }).finally(() => waited?.())
  }

  close(): void {
    this.closed = true
    for (const request of this.waiting) {
      this.remove(request)
      request.reject(this.stopped())
    }
  }

  private permit(): () => void {
    this.active++
    let held = true
    return () => {
      if (!held) return
      held = false
      this.active--
      if (this.closed) return
      const request = this.waiting.values().next().value
      if (!request) return
      this.remove(request)
      request.resolve(this.permit())
    }
  }

  private remove(request: WaitingRequest): boolean {
    if (!this.waiting.delete(request)) return false
    this.queuedBytes -= request.bytes
    clearTimeout(request.timer)
    request.signal.removeEventListener('abort', request.abort)
    return true
  }

  private busy(): AppError {
    return new AppError(429, 'gateway-busy', '模型请求正在排队，请稍后重试。')
  }

  private stopped(): AppError {
    return new AppError(503, 'model-queue-closed', '这台电脑正在停止模型请求。')
  }
}
