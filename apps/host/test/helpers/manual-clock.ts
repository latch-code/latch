/**
 * A clock a test moves by hand, for the model scheduler: `sleep` resolves only when `advance` reaches its time, so a
 * backoff, a first-byte limit or a breaker's minute passes without waiting for it. `random` is fixed.
 */
export function manualClock(random = 0.5) {
  let now = Date.UTC(2026, 0, 1)
  let sleepers: Array<{ at: number; resolve(): void }> = []
  const flush = async () => {
    for (let turn = 0; turn < 20; turn++) await new Promise<void>(resolve => setImmediate(resolve))
  }
  return {
    clock: {
      now: () => now,
      random: () => random,
      sleep(ms: number, signal: AbortSignal): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          if (signal.aborted) return reject(signal.reason as Error)
          const sleeper = { at: now + ms, resolve }
          sleepers.push(sleeper)
          signal.addEventListener(
            'abort',
            () => {
              sleepers = sleepers.filter(item => item !== sleeper)
              reject(signal.reason as Error)
            },
            { once: true },
          )
        })
      },
    },
    /** Moves time on and wakes what was due, in order; then lets what woke run. */
    async advance(ms: number): Promise<void> {
      const until = now + ms
      for (;;) {
        const due = sleepers.filter(item => item.at <= until).toSorted((a, b) => a.at - b.at)[0]
        if (!due) break
        now = Math.max(now, due.at)
        sleepers = sleepers.filter(item => item !== due)
        due.resolve()
        await flush()
      }
      now = until
      await flush()
    },
    /** How long from now each pending sleep ends, soonest first. */
    pending: (): number[] => sleepers.map(item => item.at - now).toSorted((a, b) => a - b),
    flush,
  }
}
