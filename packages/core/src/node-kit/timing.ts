/**
 * Times the drivers record on runs and messages, measured the same way by each of them. Every time comes from the
 * driver's clock (milliseconds since the epoch) and leaves as an ISO string; durations are whole milliseconds.
 */

export const isoTime = (ms: number): string => new Date(ms).toISOString()

/**
 * One run, from the prompt to its settlement. The approval wait is the union of the intervals in which at least one
 * approval is open: an agent may hold several at once, and overlapping waits count once.
 */
export class RunClock {
  readonly startedAt: number
  private readonly now: () => number
  private readonly open = new Set<string>()
  private waited = 0
  private waitingSince: number | undefined

  constructor(now: () => number) {
    this.now = now
    this.startedAt = now()
  }

  /** An approval starts to wait; the wait begins with the first one open. Opening the same key twice counts once. */
  openWait(key: string): void {
    if (this.open.has(key)) return
    if (this.open.size === 0) this.waitingSince = this.now()
    this.open.add(key)
  }

  /** An approval was answered or withdrawn; the wait ends with the last one open. */
  closeWait(key: string): void {
    if (!this.open.delete(key) || this.open.size > 0 || this.waitingSince === undefined) return
    this.waited += Math.max(0, this.now() - this.waitingSince)
    this.waitingSince = undefined
  }

  /** The approval wait so far, the interval still open included. */
  waitMs(at: number = this.now()): number {
    return this.waited + (this.waitingSince === undefined ? 0 : Math.max(0, at - this.waitingSince))
  }

  /** The live projection a detail carries while the run lasts. */
  live(): { runStartedAt: string; runWaitMs: number; runWaitingSince?: string } {
    return {
      runStartedAt: isoTime(this.startedAt),
      runWaitMs: this.waited,
      ...(this.waitingSince === undefined ? {} : { runWaitingSince: isoTime(this.waitingSince) }),
    }
  }

  /** What the turn took once it settled: its end, its working time without the approval wait, and that wait. */
  turn(): { endedAt: string; activeMs: number; waitMs: number } {
    const end = this.now()
    const waitMs = this.waitMs(end)
    return { endedAt: isoTime(end), activeMs: Math.max(0, end - this.startedAt - waitMs), waitMs }
  }
}

/**
 * Reasoning of one model step or agent reply: a span opens at the first reasoning and closes at the first text that
 * follows it or when the step ends; reasoning that resumes later opens another span. The total is the spans' sum.
 */
export class ReasoningTimer {
  private readonly now: () => number
  private total = 0
  private openedAt: number | undefined
  private firstAt: number | undefined

  constructor(now: () => number) {
    this.now = now
  }

  reasoning(): void {
    const at = this.now()
    this.firstAt ??= at
    this.openedAt ??= at
  }

  text(): void {
    if (this.openedAt === undefined) return
    this.total += Math.max(0, this.now() - this.openedAt)
    this.openedAt = undefined
  }

  /** Closes an open span; the step's reasoning time, or undefined when it reported none. */
  end(): number | undefined {
    this.text()
    return this.firstAt === undefined ? undefined : this.total
  }

  /** While live: when reasoning began, and its total once it is no longer reasoning (the reply's text has started). */
  live(): { liveReasoningStartedAt?: string; liveReasoningMs?: number } {
    if (this.firstAt === undefined) return {}
    return {
      liveReasoningStartedAt: isoTime(this.firstAt),
      ...(this.openedAt === undefined ? { liveReasoningMs: this.total } : {}),
    }
  }
}
