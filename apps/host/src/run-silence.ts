import type { KeepWaitingResult, RunLive } from '@latch/protocol'

/** How long an activity may stay quiet before the Host says so. A long test is legitimately quiet; a model rarely is. */
export const SILENCE_THRESHOLDS = { model: 2 * 60_000, command: 10 * 60_000 }

type Thresholds = typeof SILENCE_THRESHOLDS
type Family = keyof Thresholds

/** Waiting on a person or on a stop has its own timers, and silence says nothing about it. */
const FAMILY: Partial<Record<RunLive['activity'], Family>> = { starting: 'model', model: 'model', command: 'command', tool: 'command' }

/** A driver need not notify for every sign of life, so a silent run is looked at again: nothing else would tell it went on. */
const SILENT_RECHECK_MS = 30_000

export interface LiveRun {
  sessionId: string
  live: RunLive
}

interface RunSilenceOptions {
  now: () => number
  thresholds?: Thresholds
  /** The runs live now, from memory: this runs on every change of a session. */
  runs: () => LiveRun[]
  /** Whether `runs` speaks for this session's driver: only then does its absence there mean its run is over. */
  reportsRuns: (sessionId: string) => boolean
  /** A run went silent, or a timer found it no longer is. */
  changed: (sessionId: string) => void
}

/**
 * Evaluates the silence of live runs. It only reports: nothing here stops a run. One timer waits for the earliest
 * threshold or recheck and exists only while a run can cross one or is silent, so an idle Host pays nothing, and a
 * crossing is one ordinary session change. The silence itself is computed whenever a summary is read, so no reader can see a stale answer.
 */
export class RunSilence {
  /** Thresholds 「继续等」 changed, for the run they were changed in. */
  private readonly extended = new Map<string, { runId: string; thresholds: Thresholds }>()
  /** Silences already announced, so each is told once. */
  private readonly announced = new Map<string, string>()
  private timer?: NodeJS.Timeout
  private armedFor?: number
  private closed = false

  constructor(private readonly options: RunSilenceOptions) {}

  private thresholdOf(sessionId: string, runId: string, family: Family): number {
    const extended = this.extended.get(sessionId)
    return (extended?.runId === runId ? extended.thresholds : (this.options.thresholds ?? SILENCE_THRESHOLDS))[family]
  }

  /** The run as a reader sees it: whatever a driver claims about silence is replaced by the Host's own reading. */
  evaluate(sessionId: string, live: RunLive): RunLive {
    const { silenceThresholdMs: _threshold, silent: _silent, ...rest } = live
    const family = FAMILY[live.activity]
    const quietSince = Date.parse(live.lastEventAt)
    if (!family || !Number.isFinite(quietSince)) return rest
    const thresholdMs = this.thresholdOf(sessionId, live.runId, family)
    return {
      ...rest,
      silenceThresholdMs: thresholdMs,
      ...(this.options.now() - quietSince >= thresholdMs ? { silent: true as const } : {}),
    }
  }

  /** After a driver's own change, which readers already hear about. */
  check(): void {
    this.sweep(false)
  }

  /** Announces new silences and waits for the next one. Events only move thresholds later, so an armed earlier timer stays. */
  private sweep(tellRecovered: boolean): void {
    if (this.closed) return
    const runs = this.options.runs()
    const live = new Set<string>()
    let next: number | undefined
    const soonest = (due: number) => {
      if (next === undefined || due < next) next = due
    }
    for (const { sessionId, live: run } of runs) {
      live.add(sessionId)
      const seen = this.evaluate(sessionId, run)
      if (seen.silent) {
        soonest(this.options.now() + SILENT_RECHECK_MS)
        const key = `${run.runId}:${run.activity}:${run.lastEventAt}:${seen.silenceThresholdMs}`
        if (this.announced.get(sessionId) === key) continue
        this.announced.set(sessionId, key)
        this.options.changed(sessionId)
      } else {
        if (this.announced.delete(sessionId) && tellRecovered) this.options.changed(sessionId)
        if (seen.silenceThresholdMs !== undefined) soonest(Date.parse(run.lastEventAt) + seen.silenceThresholdMs)
      }
    }
    for (const sessionId of this.extended.keys())
      if (!live.has(sessionId) && this.options.reportsRuns(sessionId)) this.extended.delete(sessionId)
    for (const sessionId of this.announced.keys()) if (!live.has(sessionId)) this.announced.delete(sessionId)
    this.arm(next)
  }

  private arm(due: number | undefined): void {
    if (due === undefined) return this.disarm()
    if (this.timer && this.armedFor !== undefined && this.armedFor <= due) return
    this.disarm()
    this.armedFor = due
    this.timer = setTimeout(
      () => {
        this.disarm()
        this.sweep(true)
      },
      Math.max(0, due - this.options.now()),
    )
    this.timer.unref()
  }

  private disarm(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.armedFor = undefined
  }

  /**
   * 「继续等」: doubles the threshold the person saw, for this run and this kind of activity. Naming that threshold makes
   * a retry and a second device harmless. It doubles again while the next ask would come within half the original
   * threshold, so a page left open for a while does not ask again at once.
   */
  keepWaiting(run: LiveRun | undefined, seenThresholdMs: number, runId: string): KeepWaitingResult {
    if (!run || run.live.runId !== runId) return { outcome: 'ended' }
    const seen = this.evaluate(run.sessionId, run.live)
    const family = FAMILY[run.live.activity]
    const thresholdMs = seen.silenceThresholdMs
    if (!family || thresholdMs === undefined) return { outcome: 'not-silent' }
    if (thresholdMs !== seenThresholdMs) return { outcome: 'unchanged', thresholdMs }
    if (!seen.silent) return { outcome: 'not-silent', thresholdMs }
    const base = (this.options.thresholds ?? SILENCE_THRESHOLDS)[family]
    const quiet = this.options.now() - Date.parse(run.live.lastEventAt)
    let next = thresholdMs * 2
    while (next - quiet < base / 2) next *= 2
    const current = this.extended.get(run.sessionId)
    const thresholds = current?.runId === runId ? current.thresholds : (this.options.thresholds ?? SILENCE_THRESHOLDS)
    this.extended.set(run.sessionId, { runId, thresholds: { ...thresholds, [family]: next } })
    this.check()
    return { outcome: 'extended', thresholdMs: next }
  }

  close(): void {
    this.closed = true
    this.disarm()
  }
}
