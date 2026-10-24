export type { AgentRecord } from '@latch/protocol'

/** Timing and size limits and the diagnostics sink. The defaults suit production; tests shorten them. */
export interface AcpAgentOptions {
  /** A cancelled turn that has not settled by then kills the agent's process group. Default 30 s. */
  cancelGraceMs?: number
  /** A resumable agent process without a running turn stops after this long. Default 10 min. */
  idleMs?: number
  /** Limit for `initialize` and session setup requests. Default 120 s. */
  requestTimeoutMs?: number
  /** Wait between stdin end, SIGTERM and SIGKILL when stopping a process. Default 5 s. */
  stopGraceMs?: number
  /** Longest accepted stdout line; a longer one kills the process. Default 64 MiB. */
  maxLineBytes?: number
  /** First restart delay after a crash; it doubles for each further recent crash. Default 250 ms. */
  restartDelayMs?: number
  /** Agent processes of one definition at a time; each session has its own. Default 8. */
  maxProcesses?: number
  /** Owner-only diagnostics such as an agent's redacted stderr, kept out of task messages. Default: the Host log. */
  log?: (text: string) => void
}

export interface ResolvedOptions {
  cancelGraceMs: number
  idleMs: number
  requestTimeoutMs: number
  stopGraceMs: number
  maxLineBytes: number
  restartDelayMs: number
  maxProcesses: number
  log(text: string): void
}

export function resolveOptions(options: AcpAgentOptions = {}): ResolvedOptions {
  const pick = (value: number | undefined, fallback: number): number => {
    if (value === undefined) return fallback
    if (!Number.isFinite(value) || value < 0) throw new Error('ACP agent options must be non-negative numbers')
    return value
  }
  return {
    cancelGraceMs: pick(options.cancelGraceMs, 30_000),
    idleMs: pick(options.idleMs, 10 * 60_000),
    requestTimeoutMs: pick(options.requestTimeoutMs, 120_000),
    stopGraceMs: pick(options.stopGraceMs, 5_000),
    maxLineBytes: pick(options.maxLineBytes, 64 * 1024 * 1024),
    restartDelayMs: pick(options.restartDelayMs, 250),
    maxProcesses: (() => {
      const value = pick(options.maxProcesses, 8)
      if (!Number.isInteger(value) || value < 1) throw new Error('ACP maxProcesses must be a positive integer')
      return value
    })(),
    log: options.log ?? (text => console.error(`[Latch] ${text}`)),
  }
}

const CRASH_WINDOW_MS = 60_000
const CRASH_LIMIT = 3

/** Readiness shared by a driver and the bridges it creates. */
export class AgentHealth {
  private crashes: number[] = []
  private pauseEnd?: number
  /** Short description of the last failed start or crash; cleared by a successful `initialize`. */
  lastError?: string

  crashed(at = Date.now()): void {
    this.crashes = [...this.recent(at), at]
    if (this.crashes.length >= CRASH_LIMIT) this.pauseEnd = at + CRASH_WINDOW_MS
  }

  recent(at = Date.now()): number[] {
    return this.crashes.filter(time => at - time < CRASH_WINDOW_MS)
  }

  /** Restarts pause for a minute after the third crash within a minute, counted from that crash. */
  pausedUntil(at = Date.now()): number | undefined {
    return this.pauseEnd !== undefined && at < this.pauseEnd ? this.pauseEnd : undefined
  }

  restartDelay(base: number, at = Date.now()): number {
    const count = this.recent(at).length
    return count ? Math.min(base * 2 ** (count - 1), 5_000) : 0
  }
}
