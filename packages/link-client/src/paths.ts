import { PathGeneration } from '@latch/link-wire'

export interface LinkConnection {
  close(): void
}
export interface PathCandidate<Connection extends LinkConnection> {
  id: string
  kind: 'direct' | 'relay'
  connect(signal: AbortSignal): Promise<Connection>
}
export type PathResult<Connection, Snapshot> =
  | { kind: 'installed'; connection: Connection; candidateId: string; snapshot: Snapshot }
  | { kind: 'unchanged' | 'superseded' }

interface Race<Connection> {
  generation: { race: number; network: number }
  controllers: Set<AbortController>
  held: Set<Connection>
  cancelled: boolean
  installed: boolean
}
function close(connection: LinkConnection): void {
  try {
    connection.close()
  } catch {
    /* Cleanup cannot install an obsolete path. */
  }
}
function bounded<Value>(operation: Promise<Value>, controller: AbortController, timeout: number): Promise<Value> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(new Error('Path setup cancelled'))
    }
    const timer = setTimeout(() => controller.abort(), timeout)
    timer.unref()
    controller.signal.addEventListener('abort', abort, { once: true })
    if (controller.signal.aborted) abort()
    void operation.then(
      value => {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', abort)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', abort)
        reject(new Error('Path setup failed'))
      },
    )
  })
}
function delay(milliseconds: number, controller: AbortController): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer)
      reject(new Error('Path setup cancelled'))
    }
    const timer = setTimeout(() => {
      controller.signal.removeEventListener('abort', aborted)
      resolve()
    }, milliseconds)
    timer.unref()
    controller.signal.addEventListener('abort', aborted, { once: true })
    if (controller.signal.aborted) aborted()
  })
}

/** Owns path setup, cancellation and installation. A resume callback returns state; only the installed result may apply it. */
export class PathManager<Connection extends LinkConnection> {
  private readonly generation = new PathGeneration()
  private readonly failures = new Map<string, number>()
  private readonly disposed = new WeakSet<Connection>()
  private activeResult?: object
  private active?: { connection: Connection; candidateId: string }
  private race?: Race<Connection>
  private stopped = false
  private readonly options: {
    connectTimeoutMs: number
    resumeTimeoutMs: number
    relayDelayMs: number
    retryAfterMs: number
    parallel: number
    now: () => number
  }
  constructor(
    options: Partial<{
      connectTimeoutMs: number
      resumeTimeoutMs: number
      relayDelayMs: number
      retryAfterMs: number
      parallel: number
      now: () => number
    }> = {},
  ) {
    this.options = {
      connectTimeoutMs: 5000,
      resumeTimeoutMs: 10_000,
      relayDelayMs: 250,
      retryAfterMs: 2000,
      parallel: 3,
      now: Date.now,
      ...options,
    }
    const value = this.options
    if (
      ![value.connectTimeoutMs, value.resumeTimeoutMs, value.relayDelayMs, value.retryAfterMs].every(
        size => Number.isInteger(size) && size >= 0 && size <= 120_000,
      )
      || value.connectTimeoutMs === 0
      || value.resumeTimeoutMs === 0
      || !Number.isInteger(value.parallel)
      || value.parallel < 1
      || value.parallel > 4
    )
      throw new RangeError('Invalid path limits')
  }
  current(): Readonly<{ connection: Connection; candidateId: string }> | undefined {
    return this.active
  }
  isCurrent<Snapshot>(result: PathResult<Connection, Snapshot>): boolean {
    return result.kind === 'installed' && this.active?.connection === result.connection && this.activeResult === result
  }
  private dispose(connection: Connection): void {
    if (!this.disposed.has(connection)) {
      this.disposed.add(connection)
      close(connection)
    }
  }
  private currentRace(race: Race<Connection>): boolean {
    return !this.stopped && !race.cancelled && this.generation.current(race.generation)
  }
  private cancelRace(): void {
    if (!this.race) return
    this.race.cancelled = true
    for (const controller of this.race.controllers) controller.abort()
    for (const connection of this.race.held) this.dispose(connection)
    this.race.held.clear()
  }
  networkChanged(): void {
    this.generation.changeNetwork()
    this.cancelRace()
    this.failures.clear()
  }
  cancelPending(): void {
    this.cancelRace()
  }
  close(): void {
    this.stopped = true
    this.networkChanged()
    if (this.active) this.dispose(this.active.connection)
    this.active = undefined
    this.activeResult = undefined
  }

  async migrate<Snapshot>(
    input: readonly PathCandidate<Connection>[],
    resume: (connection: Connection, signal: AbortSignal) => Promise<Snapshot>,
  ): Promise<PathResult<Connection, Snapshot>> {
    if (this.stopped) throw new Error('Path manager closed')
    if (
      input.length > 8
      || input.some(item => !item.id || item.id.length > 256)
      || new Set(input.map(item => item.id)).size !== input.length
    )
      throw new RangeError('Invalid path candidates')
    this.cancelRace()
    const race: Race<Connection> = {
      generation: this.generation.begin(),
      controllers: new Set(),
      held: new Set(),
      cancelled: false,
      installed: false,
    }
    this.race = race
    const now = this.options.now()
    for (const [key, until] of this.failures) if (until <= now) this.failures.delete(key)
    const eligible = input.filter(item => (this.failures.get(item.id) ?? 0) <= now)
    const direct = eligible.filter(item => item.kind === 'direct'),
      relay = eligible.filter(item => item.kind === 'relay')
    // Reserve one initial worker for relay; a silent third LAN address must not hold it until a timeout.
    const candidates = [...direct.slice(0, 2), ...relay.slice(0, 1), ...direct.slice(2), ...relay.slice(1)]
    let next = 0,
      lock: Promise<void> = Promise.resolve()
    let settle!: (result: PathResult<Connection, Snapshot>) => void
    const result = new Promise<PathResult<Connection, Snapshot>>(resolve => {
      settle = resolve
    })
    const worker = async (): Promise<void> => {
      for (;;) {
        if (!this.currentRace(race) || race.installed) return
        const candidate = candidates[next++]
        if (!candidate) return
        const controller = new AbortController()
        race.controllers.add(controller)
        let connection: Connection | undefined
        try {
          if (candidate.kind === 'relay' && direct.length) await delay(this.options.relayDelayMs, controller)
          if (!this.currentRace(race) || race.installed) return
          const connecting = candidate.connect(controller.signal)
          void connecting.then(
            value => {
              if ((controller.signal.aborted || !this.currentRace(race) || race.installed) && this.active?.connection !== value)
                this.dispose(value)
            },
            () => {},
          )
          connection = await bounded(connecting, controller, this.options.connectTimeoutMs)
          if (!this.currentRace(race) || race.installed) {
            if (this.active?.connection !== connection) this.dispose(connection)
            continue
          }
          race.held.add(connection)
          const previous = lock
          let release!: () => void
          lock = new Promise(resolve => {
            release = resolve
          })
          await previous
          try {
            if (!this.currentRace(race) || race.installed || controller.signal.aborted) continue
            const snapshot = await bounded(resume(connection, controller.signal), controller, this.options.resumeTimeoutMs)
            if (!this.currentRace(race) || race.installed || controller.signal.aborted) continue
            race.installed = true
            race.held.delete(connection)
            race.controllers.delete(controller)
            const old = this.active
            this.active = { connection, candidateId: candidate.id }
            this.failures.delete(candidate.id)
            if (old && old.connection !== connection) this.dispose(old.connection)
            for (const other of race.controllers) other.abort()
            for (const other of race.held) this.dispose(other)
            race.held.clear()
            const installed: PathResult<Connection, Snapshot> = { kind: 'installed', connection, candidateId: candidate.id, snapshot }
            this.activeResult = installed
            settle(installed)
            return
          } finally {
            release()
          }
        } catch {
          if (this.currentRace(race) && !race.installed) {
            if (this.failures.size >= 16) this.failures.delete(this.failures.keys().next().value!)
            this.failures.set(candidate.id, this.options.now() + this.options.retryAfterMs)
          }
        } finally {
          race.controllers.delete(controller)
          if (connection && this.active?.connection !== connection) {
            race.held.delete(connection)
            this.dispose(connection)
          }
        }
      }
    }
    void Promise.allSettled(Array.from({ length: Math.min(this.options.parallel, candidates.length) }, () => worker())).then(() => {
      if (!race.installed) settle({ kind: this.currentRace(race) ? 'unchanged' : 'superseded' })
    })
    return result
  }
}
