export type NativeConnectionState = 'connecting' | 'connected' | 'waiting' | 'stopped'
export interface ReconnectConnection {
  isClosed(): boolean
  onClose(listener: () => void): () => void
}
export interface NativeReconnectOptions {
  onState?(state: NativeConnectionState): void
  baseDelayMs?: number
  maxDelayMs?: number
  random?(): number
}
export interface ReconnectDriver {
  migrate(): Promise<unknown>
  current(): ReconnectConnection | undefined
  cancelPending(): void
}

/** Runs one bounded retry loop; it never owns identities, application requests or their requestIds. */
export class NativeReconnect {
  readonly done: Promise<void>
  private stopped = false
  private generation = 0
  private notify?: () => void
  private readonly driver: ReconnectDriver
  private readonly options: Required<Pick<NativeReconnectOptions, 'baseDelayMs' | 'maxDelayMs' | 'random'>> & NativeReconnectOptions
  private state?: NativeConnectionState
  constructor(driver: ReconnectDriver, options: NativeReconnectOptions = {}) {
    this.options = { baseDelayMs: 500, maxDelayMs: 30_000, random: Math.random, ...options }
    if (
      !Number.isInteger(this.options.baseDelayMs)
      || this.options.baseDelayMs < 100
      || this.options.baseDelayMs > 10_000
      || !Number.isInteger(this.options.maxDelayMs)
      || this.options.maxDelayMs < this.options.baseDelayMs
      || this.options.maxDelayMs > 60_000
    )
      throw new RangeError('Invalid native reconnect limits')
    this.driver = driver
    this.done = this.run()
  }
  wake(): void {
    this.generation++
    this.driver.cancelPending()
    this.notify?.()
  }
  isStopped(): boolean {
    return this.stopped
  }
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.wake()
  }
  private transition(state: NativeConnectionState): void {
    if (this.state === state) return
    this.state = state
    try {
      this.options.onState?.(state)
    } catch {
      /* A view callback cannot take ownership of reconnection. */
    }
  }
  private wait(generation: number, connection?: ReconnectConnection, milliseconds?: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return Promise.resolve()
    return new Promise(resolve => {
      let removeClose: (() => void) | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        removeClose?.()
        if (this.notify === done) this.notify = undefined
        resolve()
      }
      this.notify = done
      if (milliseconds !== undefined) {
        timer = setTimeout(done, milliseconds)
        timer.unref()
      }
      if (connection) {
        removeClose = connection.onClose(done)
        if (settled) removeClose()
      }
      if (this.stopped || generation !== this.generation || connection?.isClosed()) done()
    })
  }
  private async run(): Promise<void> {
    let failures = 0
    try {
      while (!this.stopped) {
        const generation = this.generation
        this.transition('connecting')
        try {
          await this.driver.migrate()
        } catch {
          /* Only this candidate round fails; identity and writes remain unchanged. */
        }
        if (this.stopped) break
        if (generation !== this.generation) continue
        const connection = this.driver.current()
        if (connection && !connection.isClosed()) {
          failures = 0
          this.transition('connected')
          await this.wait(generation, connection)
        } else {
          const ceiling = Math.min(this.options.maxDelayMs, this.options.baseDelayMs * 2 ** Math.min(failures++, 16))
          const sample = this.options.random()
          const random = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5
          this.transition('waiting')
          await this.wait(generation, undefined, Math.ceil(ceiling * (0.5 + random / 2)))
        }
      }
    } finally {
      this.stopped = true
      this.notify?.()
      this.transition('stopped')
    }
  }
}
