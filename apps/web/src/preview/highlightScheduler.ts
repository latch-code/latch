import { isSyntaxLines, type HighlightRequest, type HighlightResponse, type SyntaxLines } from './highlight-protocol.ts'

/** What the scheduler needs of a `Worker`; a test passes its own. */
export interface HighlightWorker {
  postMessage(message: HighlightRequest): void
  terminate(): void
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
}
export interface SchedulerOptions {
  createWorker: () => HighlightWorker
  timeoutMs?: number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}
export type LinesResult = { restart: true } | { lines: SyntaxLines } | undefined
type Cancel = () => void
type Answer = { lines?: SyntaxLines; restart?: boolean }

interface Job {
  /** The block's cache key; a job for streamed lines has none, its result only makes sense to its stream. */
  key?: string
  chars: number
  message: { code: string; language: string; stream?: number; from?: number }
  budget: number
  attempts: number
  listeners: Set<(answer: Answer | undefined) => void>
}

const CACHE_ENTRIES = 256
const CACHE_CHARS = 2_000_000
const NEGATIVE_ENTRIES = 256
/** Worker failures in a row, with no answer between them, after which the waiting jobs are given up. */
const CRASH_LIMIT = 3
/** A worker that has not answered yet is still loading: its first job waits on that too, on a busy machine or a slow phone. */
const FIRST_JOB_MS = 30_000
/** A timed-out job's second try gets this much more: under load an ordinary block can miss the first budget. */
const RETRY_BUDGET = 4

/**
 * One worker tokenizes one job at a time, so more in flight would only let older submitted jobs run ahead of the newest
 * and each carry a watchdog. Waiting jobs form a stack: what the reader reached last is what they are looking at. The
 * watchdog covers only the job in the worker. A job that outlives it twice (its retry at the bottom of the stack) is
 * remembered and never asked again; the others just wait for the next worker.
 */
export class HighlightScheduler {
  private worker: HighlightWorker | undefined
  private nextId = 0
  private active: { id: number; job: Job; timer: unknown } | undefined
  private crashes = 0
  private workerAnswered = false
  private readonly waiting: Job[] = []
  private readonly cache = new Map<string, { lines: SyntaxLines; chars: number }>()
  private cachedChars = 0
  private readonly negative = new Set<string>()
  private readonly createWorker: () => HighlightWorker
  private readonly timeoutMs: number
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (timer: unknown) => void

  constructor(options: SchedulerOptions) {
    this.createWorker = options.createWorker
    this.timeoutMs = options.timeoutMs ?? 5000
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  }

  /** The tokens already known for this block, without asking. */
  peek(code: string, language: string): SyntaxLines | undefined {
    return this.cache.get(blockKey(code, language))?.lines
  }

  /** Asks for a whole block; `done` runs at most once, with no lines when it stays plain. Returns the cancel. */
  request(code: string, language: string, done: (lines: SyntaxLines | undefined) => void): Cancel {
    const key = blockKey(code, language)
    const known = this.cache.get(key)
    if (known) {
      this.cache.delete(key)
      this.cache.set(key, known)
      done(known.lines)
      return () => {}
    }
    if (this.negative.has(key)) {
      done(undefined)
      return () => {}
    }
    const listener = (answer: Answer | undefined) => {
      done(answer?.lines)
    }
    const queued = this.waiting.findIndex(job => job.key === key)
    if (queued >= 0) {
      const [job] = this.waiting.splice(queued, 1)
      job!.listeners.add(listener)
      this.waiting.push(job!)
      return this.canceller(job!, listener)
    }
    if (this.active?.job.key === key) {
      this.active.job.listeners.add(listener)
      return this.canceller(this.active.job, listener)
    }
    return this.enqueue({ key, chars: code.length, message: { code, language } }, listener)
  }

  /**
   * Asks for the next complete lines of a stream, `code` being those lines without their last newline and `from` the
   * index of the first. A worker that no longer holds the stream answers `restart`.
   */
  requestLines(stream: number, language: string, from: number, code: string, done: (result: LinesResult) => void): Cancel {
    return this.enqueue({ chars: code.length, message: { code, language, stream, from } }, answer => {
      if (answer?.restart) done({ restart: true })
      else done(answer?.lines ? { lines: answer.lines } : undefined)
    })
  }

  /** The stream is over: the worker can forget its grammar state. */
  release(stream: number): void {
    this.worker?.postMessage({ release: stream })
  }

  private enqueue(job: Pick<Job, 'key' | 'chars' | 'message'>, listener: (answer: Answer | undefined) => void): Cancel {
    const full: Job = { ...job, budget: this.timeoutMs, attempts: 0, listeners: new Set([listener]) }
    this.waiting.push(full)
    this.pump()
    return this.canceller(full, listener)
  }

  /** A job nobody wants leaves the stack. One already in the worker finishes, and a block's result still fills the cache. */
  private canceller(job: Job, listener: (answer: Answer | undefined) => void): Cancel {
    return () => {
      job.listeners.delete(listener)
      if (job.listeners.size > 0) return
      const index = this.waiting.indexOf(job)
      if (index >= 0) this.waiting.splice(index, 1)
    }
  }

  private pump(): void {
    if (this.active) return
    const job = this.waiting.pop()
    if (!job) return
    try {
      this.worker ??= this.spawn()
      const id = ++this.nextId
      const budget = this.workerAnswered ? job.budget : Math.max(job.budget, FIRST_JOB_MS)
      this.active = { id, job, timer: this.setTimer(() => this.onTimeout(id), budget) }
      this.worker.postMessage({ id, ...job.message })
    } catch {
      this.waiting.push(job)
      this.onCrash()
    }
  }

  private spawn(): HighlightWorker {
    const worker = this.createWorker()
    this.workerAnswered = false
    worker.onerror = () => this.onCrash()
    worker.onmessage = event => {
      const value = event.data as HighlightResponse | null | undefined
      if (!this.active || value?.id !== this.active.id) return
      const { job, timer } = this.active
      this.clearTimer(timer)
      this.active = undefined
      this.crashes = 0
      this.workerAnswered = true
      this.finish(job, value)
      this.pump()
    }
    return worker
  }

  private finish(job: Job, value: HighlightResponse): void {
    if (value.restart === true) {
      settle(job, { restart: true })
      return
    }
    if (!isSyntaxLines(value.lines, job.message.code)) {
      settle(job, undefined)
      return
    }
    if (job.key !== undefined) this.remember(job.key, value.lines, job.chars)
    settle(job, { lines: value.lines })
  }

  private remember(key: string, lines: SyntaxLines, chars: number): void {
    this.cache.set(key, { lines, chars })
    this.cachedChars += chars
    for (const [oldest, value] of this.cache) {
      if (oldest === key || (this.cache.size <= CACHE_ENTRIES && this.cachedChars <= CACHE_CHARS)) break
      this.cache.delete(oldest)
      this.cachedChars -= value.chars
    }
  }

  private stopWorker(): void {
    this.worker?.terminate()
    this.worker = undefined
  }

  private onTimeout(id: number): void {
    if (this.active?.id !== id) return
    const { job } = this.active
    this.active = undefined
    this.stopWorker()
    this.retryOrDrop(job)
    this.pump()
  }

  private onCrash(): void {
    const job = this.active?.job
    if (this.active) this.clearTimer(this.active.timer)
    this.active = undefined
    this.stopWorker()
    // A crash says nothing about the block, which is what a worker that fails to load looks like: it waits for the next.
    if (job?.key === undefined) {
      if (job) settle(job, undefined)
    } else if (job.listeners.size > 0) this.waiting.unshift(job)
    if (++this.crashes >= CRASH_LIMIT) {
      // The worker cannot run here. The next request tries again; nothing retries on its own.
      this.crashes = 0
      for (const waiting of this.waiting.splice(0)) settle(waiting, undefined)
      return
    }
    this.pump()
  }

  /** A stream can always restart from its text once it closes, so only a block earns a second try. */
  private retryOrDrop(job: Job): void {
    if (job.key === undefined) {
      settle(job, undefined)
      return
    }
    // Nobody is waiting for it, so it says nothing about the block and costs nothing to forget.
    if (job.listeners.size === 0) return
    if (++job.attempts < 2) {
      job.budget *= RETRY_BUDGET
      this.waiting.unshift(job)
      return
    }
    this.negative.add(job.key)
    if (this.negative.size > NEGATIVE_ENTRIES) this.negative.delete(this.negative.values().next().value!)
    settle(job, undefined)
  }
}

const blockKey = (code: string, language: string) => `${language}\0${code}`

function settle(job: Job, answer: Answer | undefined): void {
  for (const listener of job.listeners) listener(answer)
  job.listeners.clear()
}
