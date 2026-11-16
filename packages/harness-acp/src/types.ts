export type { AgentRecord } from '@latch/protocol'
import type { TokenUsage } from '@latch/protocol'
import type { QuotaReport } from './quota.ts'

/** Timing and size limits and the diagnostics sink. The defaults suit production; tests shorten them. */
export interface AcpAgentOptions {
  /** A cancelled turn that has not settled by then kills the agent's process group. Default 30 s. */
  cancelGraceMs?: number
  /** A resumable agent process without a running turn stops after this long. Default 10 min. */
  idleMs?: number
  /** Limit for other setup and configuration requests. Default 120 s. */
  requestTimeoutMs?: number
  /**
   * Limit for the agent's answer to one session config change; an agent that has not answered by then leaves the change
   * unknown until it is checked. Default 30 s, never more than `requestTimeoutMs`.
   */
  configTimeoutMs?: number
  /**
   * Limit for `initialize`: an agent that has not answered by then is stopped and the start refused
   * (`agent-handshake-timeout`), so a too-old or broken agent never holds a session open. Default 30 s.
   */
  handshakeTimeoutMs?: number
  /** The same for `session/new`, `session/resume` and `session/load`. Default 60 s. */
  sessionSetupTimeoutMs?: number
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
  /**
   * Starts only a definition this Mac confirmed (`AgentRecord.confirmedCommand`); one saved before confirmations is
   * refused (409 `harness-unconfirmed`) until it is confirmed once. The Host sets it; drivers built in tests may not.
   */
  requireConfirmedCommand?: boolean
  /**
   * The Host's own read of this definition's limits, outside the agent's process: for a preset whose CLI holds an API
   * key for a vendor with an official balance endpoint (`apps/host/src/cli-quota.ts`). Asked only as a turn ends, at
   * most once in five minutes, with the session's folder. `null`: there is nothing to report (no key, a refusal, a
   * setting that sends the key elsewhere), and what was shown goes; `undefined`: this read did not finish.
   */
  readQuota?: (input: { cwd: string; signal: AbortSignal }) => Promise<QuotaReport | null | undefined>
  /**
   * The Host's own read of a turn's tokens from the CLI's record of this one session (`apps/host/src/cli-usage.ts`),
   * for a preset whose adapter reports none. Asked once as a turn on the Harness's own login ends with no usage from
   * the agent, never for a session brought in: `sessionId` is the agent's ID Latch started, `cwd` the folder sent with
   * it, and the times the turn's. Undefined: not known, and the turn is recorded without tokens.
   */
  readTurnUsage?: (input: {
    sessionId: string
    cwd: string
    from: number
    to: number
    signal: AbortSignal
  }) => Promise<TokenUsage | undefined>
  /** How long `readTurnUsage` may take; past it, plus a second, the turn is recorded without tokens. Default 10 s. */
  turnUsageReadMs?: number
}

export interface ResolvedOptions {
  cancelGraceMs: number
  idleMs: number
  requestTimeoutMs: number
  configTimeoutMs: number
  handshakeTimeoutMs: number
  sessionSetupTimeoutMs: number
  stopGraceMs: number
  maxLineBytes: number
  restartDelayMs: number
  maxProcesses: number
  log(text: string): void
  requireConfirmedCommand: boolean
  readQuota?: AcpAgentOptions['readQuota']
  readTurnUsage?: AcpAgentOptions['readTurnUsage']
  turnUsageReadMs: number
}

export function resolveOptions(options: AcpAgentOptions = {}): ResolvedOptions {
  const pick = (value: number | undefined, fallback: number): number => {
    if (value === undefined) return fallback
    if (!Number.isFinite(value) || value < 0) throw new Error('ACP agent options must be non-negative numbers')
    return value
  }
  return {
    requireConfirmedCommand: options.requireConfirmedCommand === true,
    cancelGraceMs: pick(options.cancelGraceMs, 30_000),
    idleMs: pick(options.idleMs, 10 * 60_000),
    requestTimeoutMs: pick(options.requestTimeoutMs, 120_000),
    configTimeoutMs: Math.min(pick(options.configTimeoutMs, 30_000), pick(options.requestTimeoutMs, 120_000)),
    handshakeTimeoutMs: pick(options.handshakeTimeoutMs, 30_000),
    sessionSetupTimeoutMs: pick(options.sessionSetupTimeoutMs, 60_000),
    stopGraceMs: pick(options.stopGraceMs, 5_000),
    turnUsageReadMs: pick(options.turnUsageReadMs, 10_000),
    maxLineBytes: pick(options.maxLineBytes, 64 * 1024 * 1024),
    restartDelayMs: pick(options.restartDelayMs, 250),
    maxProcesses: (() => {
      const value = pick(options.maxProcesses, 8)
      if (!Number.isInteger(value) || value < 1) throw new Error('ACP maxProcesses must be a positive integer')
      return value
    })(),
    log: options.log ?? (text => console.error(`[Latch] ${text}`)),
    ...(options.readQuota ? { readQuota: options.readQuota } : {}),
    ...(options.readTurnUsage ? { readTurnUsage: options.readTurnUsage } : {}),
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
