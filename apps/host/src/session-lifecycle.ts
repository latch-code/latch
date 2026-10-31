import type { TaskStatus, TaskSummary } from '@latch/protocol'
import type { ProjectFolder } from '@latch/sdk'
import { errorText } from './http-util.ts'

/** How a run ended, as its driver records it (`TaskSummary.runOutcome`). */
type RunOutcome = NonNullable<TaskSummary['runOutcome']>

/** The project a session belongs to: one that recorded none works in the start directory, project `default`. */
export function projectIdOf(summary: Pick<TaskSummary, 'workspaceId'>): string {
  return summary.workspaceId ?? 'default'
}

/** Each event and what its listeners receive. */
export interface SessionLifecycleEvents {
  /**
   * A run is about to send its first prompt to its engine (the model service or the agent), which waits for these
   * listeners first. The runs announced are those whose driver tracks their files (`trackFiles`): every Agent-mode run
   * of the built-in harness and every ACP run; a chat-only run reaches no folder and is not announced. `folders` are the
   * session's folders as the Host resolves them, the primary one first.
   */
  runStarted: { sessionId: string; projectId: string; runId: string; folders: ProjectFolder[] }
  /**
   * A run announced by `runStarted` ended, once its driver settled it, and only once, unless `hostStopping` came first.
   * A requested cancel leaves the run running until its engine stops, so it announces nothing by itself.
   */
  runSettled: { sessionId: string; runId: string; outcome: RunOutcome }
  /**
   * The session was archived, after the change was saved. A listener cannot refuse it: a rule that may refuse an archive
   * (a terminal still running, asked for from another device) is a check in the route, before the change.
   */
  sessionArchived: { sessionId: string; projectId: string }
  /** The session was deleted, after its driver removed it; `projectId` is here because nothing can look it up any more. */
  sessionDeleted: { sessionId: string; projectId: string }
  /**
   * The Host began to stop: it takes no more requests, and its drivers and listeners stay open until these settle. This
   * ends every run still open: none of them gets a `runSettled`, in this process or the next, so a subscriber treats
   * this event as their end and recovers what it recorded for them when the Host next starts.
   */
  hostStopping: undefined
}

export type LifecycleEvent = keyof SessionLifecycleEvents
export type LifecycleListener<E extends LifecycleEvent> = (payload: SessionLifecycleEvents[E]) => void | Promise<void>
/** What a subscriber is given: it can listen to the events, never announce one. */
export type LifecycleListeners = Pick<SessionLifecycle, 'on'>

/** How long the work waits for the listeners of `runStarted` and `hostStopping`, in milliseconds. */
export interface LifecycleBounds {
  /** A run's first prompt; long enough for a snapshot of the session's folders. */
  runStarted: number
  /** A stop; the desktop app and `pnpm stop` give the whole stop 10 seconds. */
  hostStopping: number
}

const LIFECYCLE_BOUNDS: Readonly<LifecycleBounds> = { runStarted: 15_000, hostStopping: 3_000 }

const ACTIVE: ReadonlySet<TaskStatus> = new Set(['running', 'waiting-approval'])
/** What a driver that records no outcome ended a run with, judged by its status as the built-in drivers do. */
const STATUS_OUTCOME: Partial<Record<TaskStatus, RunOutcome>> = { idle: 'completed', cancelled: 'cancelled', interrupted: 'interrupted' }

/** A run about to send its first prompt. */
export interface RunStarting {
  sessionId: string
  runId: string
  /** Cancels the run in its driver, for a stop that began while it is held or before it was announced. */
  cancel(): void
  /** What `runStarted` says about the run, read under the same bound; undefined: it is not to be announced. */
  lookup(): Promise<Pick<SessionLifecycleEvents['runStarted'], 'projectId' | 'folders'> | undefined>
}

interface Hold {
  runId: string
  cancel: () => void
  release: () => void
}

/**
 * Typed events about sessions and the Host itself, for the modules that keep something per session (snapshots of its
 * folders, its terminals) without editing server.ts or hub.ts. Listeners may be async. `runStarted` and `hostStopping`
 * hold the run's first prompt and the stop until every listener settled, never longer than their bound; the other
 * events never wait. A listener that throws, rejects or
 * outlasts the bound is logged and changes nothing else; one that outlasts it keeps running. Each listener gets its own
 * copy of the payload.
 */
export class SessionLifecycle {
  private readonly listeners: { [E in LifecycleEvent]: Set<LifecycleListener<E>> } = {
    runStarted: new Set(),
    runSettled: new Set(),
    sessionArchived: new Set(),
    sessionDeleted: new Set(),
    hostStopping: new Set(),
  }
  /** Runs announced by `runStarted` and not yet seen to settle, by session. */
  private readonly runs = new Map<string, string>()
  private readonly bounds: LifecycleBounds
  /** Runs waiting for `runStarted` to finish before their first prompt, by session. */
  private readonly holds = new Map<string, Hold>()
  private stopped = false

  constructor(private readonly options: { log: (text: string) => void; bounds?: Partial<LifecycleBounds> }) {
    this.bounds = { ...LIFECYCLE_BOUNDS, ...options.bounds }
  }

  on<E extends LifecycleEvent>(event: E, listener: LifecycleListener<E>): () => void {
    const listeners = this.listeners[event]
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  /** The object subscribers are handed: its only property is `on`, so it cannot announce anything at runtime either. */
  listenOnly(): LifecycleListeners {
    return Object.freeze({
      on: <E extends LifecycleEvent>(event: E, listener: LifecycleListener<E>) => this.on(event, listener),
    })
  }

  /**
   * A cancel reached the driver: nothing has reached the engine while the run is held, so it stops waiting. It goes on
   * in the next turn of the event loop, because a driver records a cancel a few microtasks after it is called, and that
   * is what keeps the released run from its engine.
   */
  cancelRequested(sessionId: string, runId?: string): void {
    const hold = this.holds.get(sessionId)
    if (!hold || (runId !== undefined && hold.runId !== runId)) return
    setImmediate(() => {
      if (this.holds.get(sessionId) === hold) this.holds.delete(sessionId)
      hold.release()
    })
  }

  /** Whether a run about to start needs any work done for it. */
  listensToRuns(): boolean {
    return this.listens('runStarted') || this.listens('runSettled')
  }

  /**
   * Holds a run while it is looked up and announced, and resolves once that is done or the bound passed; a lookup still
   * under way by then announces nothing, because the prompt has gone out. A run is announced once.
   */
  async runStarted(run: RunStarting): Promise<void> {
    if (this.stopped) {
      run.cancel()
      await new Promise(setImmediate)
      return
    }
    if (this.runs.get(run.sessionId) === run.runId || this.holds.get(run.sessionId)?.runId === run.runId) return
    let release = () => {}
    const released = new Promise<void>(resolve => {
      release = resolve
    })
    const hold: Hold = { runId: run.runId, cancel: run.cancel, release }
    this.holds.set(run.sessionId, hold)
    await this.within('runStarted', this.announce(run, hold), this.bounds.runStarted, released)
    if (this.holds.get(run.sessionId) === hold) this.holds.delete(run.sessionId)
  }

  private async announce(run: RunStarting, hold: Hold): Promise<void> {
    let facts: Awaited<ReturnType<RunStarting['lookup']>>
    try {
      facts = await run.lookup()
    } catch (error) {
      this.options.log(`会话生命周期事件 runStarted 的处理失败：${errorText(error)}`)
      return
    }
    if (!facts || this.holds.get(run.sessionId) !== hold) return
    // A driver settles a run before it starts the next one, and the hub reads each change as it happens.
    if (this.runs.has(run.sessionId)) this.options.log(`会话 ${run.sessionId} 的上一次运行结束时没有被读到，不再通知它结束`)
    this.runs.set(run.sessionId, run.runId)
    await this.emit('runStarted', { sessionId: run.sessionId, runId: run.runId, ...facts })
  }

  /** The announced run of the session whose end someone is waiting to hear about, so its driver's reports are worth reading. */
  watchedRun(sessionId: string): string | undefined {
    return this.listens('runSettled') ? this.runs.get(sessionId) : undefined
  }

  /**
   * The session's summary as its driver reported it, read while `runId` was its announced run. Once that run neither
   * runs nor waits for an approval, it has settled, and `runSettled` goes out. A read begun before a later run was
   * announced says nothing about the later one, so it is ignored.
   */
  observe(summary: TaskSummary, runId: string): void {
    if (this.runs.get(summary.id) !== runId || (summary.runId === runId && ACTIVE.has(summary.status))) return
    this.runs.delete(summary.id)
    if (summary.runId !== runId) {
      this.options.log(`会话 ${summary.id} 已开始另一次运行，上一次运行的结果没有被读到，不再通知它结束`)
      return
    }
    void this.emit('runSettled', {
      sessionId: summary.id,
      runId,
      outcome: summary.runOutcome ?? STATUS_OUTCOME[summary.status] ?? 'failed',
    })
  }

  /** Whether anything listens to `event`, so that work done only for it can be skipped. */
  listens(event: LifecycleEvent): boolean {
    return this.listeners[event].size > 0
  }

  sessionArchived(sessionId: string, projectId: string): void {
    void this.emit('sessionArchived', { sessionId, projectId })
  }

  sessionDeleted(sessionId: string, projectId: string): void {
    this.runs.delete(sessionId)
    void this.emit('sessionDeleted', { sessionId, projectId })
  }

  /**
   * Ends what is open: no `runSettled` follows, and every held run is cancelled, then released, because a driver waits
   * for its runs to settle as it closes and none of them may reach its engine now. Resolves once the listeners settled
   * or the bound passed.
   */
  hostStopping(): Promise<void> {
    this.stopped = true
    this.runs.clear()
    const holds = [...this.holds.values()]
    this.holds.clear()
    for (const hold of holds) hold.cancel()
    setImmediate(() => {
      for (const hold of holds) hold.release()
    })
    return this.within('hostStopping', this.emit('hostStopping', undefined), this.bounds.hostStopping)
  }

  /** Calls every listener; the result settles when they all have. */
  private async emit<E extends LifecycleEvent>(event: E, payload: SessionLifecycleEvents[E]): Promise<void> {
    await Promise.all([...this.listeners[event]].map(listener => this.call(event, listener, payload)))
  }

  /** Waits for `work`, at most `bound` milliseconds and no longer than `released`, which belong to this wait alone. */
  private async within(event: LifecycleEvent, work: Promise<void>, bound: number, released?: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    // Kept referenced: a stop must not let the process end while it still waits.
    const late = new Promise<'late'>(resolve => {
      timer = setTimeout(() => resolve('late'), bound)
    })
    const ended = await Promise.race([work, late, ...(released ? [released] : [])])
    clearTimeout(timer)
    if (ended === 'late') this.options.log(`会话生命周期事件 ${event} 的处理超过 ${bound} 毫秒，已继续`)
  }

  private call<E extends LifecycleEvent>(event: E, listener: LifecycleListener<E>, payload: SessionLifecycleEvents[E]): Promise<void> {
    const failed = (error: unknown) => this.options.log(`会话生命周期事件 ${event} 的处理失败：${errorText(error)}`)
    try {
      return Promise.resolve(listener(structuredClone(payload))).then(() => {}, failed)
    } catch (error) {
      failed(error)
      return Promise.resolve()
    }
  }
}
