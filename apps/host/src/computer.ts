import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AgentMissedRun, HostComputerState } from '@latch/protocol'
import { AppError } from '@latch/sdk'
import type { AtomicWriteFs } from '@latch/core/node-kit'
import { AgentJournal } from './agent-journal.ts'

/** Sleeps and stops kept, each newest last: enough to say why a recent scheduled time was missed. */
export const MAX_SLEEPS = 32
export const MAX_STOPS = 32
/** The desktop app reports at least this often while it runs; a report older than this means it is not running. */
export const DESKTOP_STALE_MS = 60_000
/** 「到点前后保持唤醒」 starts this long before a scheduled time. */
export const KEEP_AWAKE_LEAD_MS = 2 * 60_000
/** And holds at most this long after it, even while the run goes on. */
export const KEEP_AWAKE_HOLD_MS = 30 * 60_000

const at = z.string().datetime()
const windowSchema = z.strictObject({ from: at, to: at })
const stateSchema = z.strictObject({
  version: z.literal(1),
  /** Closed sleeps the desktop app reported, oldest first. */
  sleeps: z.array(windowSchema).max(MAX_SLEEPS),
  /** The sleep reported and not yet ended by a wake. */
  sleeping: at.optional(),
  /** Times this Host was stopped in order until it started again, oldest first: Latch was not running then. */
  stops: z.array(windowSchema).max(MAX_STOPS),
  /** When this Host last stopped in order; it becomes a stop window when the next one starts. */
  stoppedAt: at.optional(),
})
type State = z.infer<typeof stateSchema>
const FILE = 'computer.json'

/** `POST /link/api/host/state` with `state: 'desktop'`: what the desktop app keeps this Mac awake for now. */
export const desktopReportSchema = z.strictObject({
  state: z.literal('desktop'),
  keepAwake: z.enum(['busy', 'schedule']).nullable(),
  /** The desktop app's main process, for 「操控这台 Mac」's guard against calls aimed at Latch. */
  pid: z.number().int().positive().optional(),
})
export type DesktopReport = z.infer<typeof desktopReportSchema>

interface Options {
  dataDir: string
  now?: () => number
  atomicFs?: AtomicWriteFs
  /** What the Host shows changed: a page reads the snapshot again. */
  changed?: () => void
  /** A record that could not be read was set aside: only the reason, never its content. */
  setAside?: (reason: 'invalid') => void
}

const push = (rows: Array<{ from: string; to: string }>, row: { from: string; to: string }, max: number) => {
  rows.push(row)
  if (rows.length > max) rows.splice(0, rows.length - max)
}

/**
 * What the Host knows of the computer it runs on, from the desktop app's reports over host.sock and its own start and
 * orderly stop: closed sleeps and stops (kept in `agents/computer.json`, bounded) and, in memory, whether the desktop
 * app runs and what it keeps awake. A missed time is said to be in a sleep, or while Latch was stopped, only when a
 * closed record covers it; otherwise its cause is unknown.
 */
export class HostComputer {
  private state: State
  private desktop: { at: number; keepAwake: DesktopReport['keepAwake']; pid?: number } | undefined
  private stale?: ReturnType<typeof setTimeout>
  private constructor(
    private readonly options: Options,
    private readonly journal: AgentJournal<State>,
  ) {
    this.state = journal.read()
  }

  static async open(options: Options): Promise<HostComputer> {
    const journalOptions = {
      directory: 'agents',
      retryMs: 1000,
      maximumBytes: 64 * 1024,
      ...(options.atomicFs ? { atomicFs: options.atomicFs } : {}),
    }
    const initial: State = { version: 1, sleeps: [], stops: [] }
    let journal: AgentJournal<State>
    try {
      journal = await AgentJournal.open(options.dataDir, FILE, stateSchema, initial, journalOptions)
    } catch (error) {
      // A record that does not read is no reason to keep the Host from starting: it goes aside, and nothing is known.
      if (!(error instanceof AppError && error.code === 'agent-journal-invalid')) throw error
      const path = join(options.dataDir, 'agents', FILE)
      await rename(path, `${path}.invalid-${(options.now ?? Date.now)()}`)
      options.setAside?.('invalid')
      journal = await AgentJournal.open(options.dataDir, FILE, stateSchema, initial, journalOptions)
    }
    const computer = new HostComputer(options, journal)
    await computer.started()
    return computer
  }

  /**
   * This Host starts: a stop it recorded becomes a window in which Latch was not running, and a sleep never ended by a
   * wake is dropped, since nothing says when it ended.
   */
  private async started(): Promise<void> {
    const stamp = this.stamp()
    await this.write(
      'start',
      draft => {
        if (draft.stoppedAt === undefined && draft.sleeping === undefined) return false
        if (draft.stoppedAt !== undefined && draft.stoppedAt <= stamp) push(draft.stops, { from: draft.stoppedAt, to: stamp }, MAX_STOPS)
        delete draft.stoppedAt
        delete draft.sleeping
        return true
      },
      false,
    )
  }

  /** The desktop app reported the Mac going to sleep. A second report ends the open sleep there and starts another. */
  async sleeping(): Promise<void> {
    const stamp = this.stamp()
    await this.write('sleep', draft => {
      if (draft.sleeping !== undefined) push(draft.sleeps, { from: draft.sleeping, to: stamp }, MAX_SLEEPS)
      draft.sleeping = stamp
      return true
    })
  }

  /** The desktop app reported the Mac waking up. A wake with no sleep before it (the report was lost) records a wake only. */
  async awake(): Promise<void> {
    const stamp = this.stamp()
    await this.write('wake', draft => {
      push(draft.sleeps, { from: draft.sleeping ?? stamp, to: stamp }, MAX_SLEEPS)
      delete draft.sleeping
      return true
    })
  }

  /** The desktop app's report of what it keeps awake; it comes on every change and at least every half minute. */
  report(input: DesktopReport): void {
    const before = JSON.stringify(this.view())
    this.desktop = { at: this.now(), keepAwake: input.keepAwake, ...(input.pid !== undefined ? { pid: input.pid } : {}) }
    clearTimeout(this.stale)
    // Once reports stop, the page hears that the desktop app no longer runs.
    this.stale = setTimeout(() => this.options.changed?.(), DESKTOP_STALE_MS + 1000)
    this.stale.unref()
    if (JSON.stringify(this.view()) !== before) this.options.changed?.()
  }

  /** The desktop app's process as it last reported it, kept after reports stop: a pid named after it went is no loss. */
  desktopPid(): number | undefined {
    return this.desktop?.pid
  }

  view(): HostComputerState {
    const desktop = this.desktop !== undefined && this.now() - this.desktop.at <= DESKTOP_STALE_MS
    const woke = this.state.sleeping === undefined ? this.state.sleeps.at(-1)?.to : undefined
    return {
      ...(woke ? { wokeAt: woke } : {}),
      desktop,
      ...(desktop && this.desktop?.keepAwake ? { keepAwake: this.desktop.keepAwake } : {}),
    }
  }

  /**
   * Why a scheduled time was missed, only as far as the records show: inside a closed sleep, inside a stop of this Host,
   * or unknown (no record covers it: the Mac off, a crash, a sleep never reported or older than what is kept).
   */
  cause(time: string): AgentMissedRun['cause'] {
    const inside = (rows: ReadonlyArray<{ from: string; to: string }>) => rows.some(row => time >= row.from && time <= row.to)
    if (inside(this.state.sleeps)) return 'sleep'
    if (inside(this.state.stops)) return 'off'
    return 'unknown'
  }

  /** An orderly stop: recorded, so the time until the next start reads as Latch not running. */
  async close(): Promise<void> {
    clearTimeout(this.stale)
    const stamp = this.stamp()
    await this.write(
      'stop',
      draft => {
        draft.stoppedAt = stamp
        return true
      },
      false,
    )
    await this.journal.close()
  }

  /** Best effort: a record that cannot be written now is retried by the journal; the memory copy holds meanwhile. */
  private async write(key: string, apply: (draft: State) => boolean, notify = true): Promise<void> {
    const draft = structuredClone(this.state)
    if (!apply(draft)) return
    this.state = draft
    if (notify) this.options.changed?.()
    await this.journal.change(`${key}:${this.now()}`, key, current => ({ value: true, changed: apply(current) })).catch(() => {})
  }
  private now(): number {
    return (this.options.now ?? Date.now)()
  }
  private stamp(): string {
    return new Date(this.now()).toISOString()
  }
}
