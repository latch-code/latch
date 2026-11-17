// One clock for every walk and search in the process: when the event loop last ran its timers. A 1 ms heartbeat runs
// while any of them works, so time spent waiting on the file system (the loop idle, timers running) never counts as
// busy, and walks running side by side share one budget instead of adding theirs up. A walk that has held the loop for
// YIELD_MS gives it back through a timer, so it resumes only after the timers already due have run.

/** The longest any walk or search works before it lets the event loop turn. */
export const YIELD_MS = 8

const clock = { since: performance.now(), active: 0, timer: undefined as NodeJS.Timeout | undefined }

/** Starts the heartbeat for one piece of work; the returned function ends it (once). */
export function beginLoopWork(): () => void {
  if (clock.active++ === 0) {
    clock.since = performance.now()
    clock.timer = setInterval(() => {
      clock.since = performance.now()
    }, 1)
    clock.timer.unref()
  }
  let ended = false
  return () => {
    if (ended) return
    ended = true
    if (--clock.active === 0) {
      clearInterval(clock.timer)
      clock.timer = undefined
    }
  }
}

/** Milliseconds since the event loop last ran its timers. */
export const sinceTurn = (): number => performance.now() - clock.since

/**
 * Lets the loop turn: resumes from a timer, after the timers already due, and waits until the heartbeat has run (the
 * loop really went round). Resuming does not by itself start a fresh window: walks that yielded together resume in the
 * same timers phase one after another, so each would otherwise add its own window to the same stretch.
 */
export async function yieldTurn(): Promise<void> {
  for (let tries = 0; tries < 20; tries++) {
    await new Promise(resolve => setTimeout(resolve, 0))
    if (clock.active === 0) clock.since = performance.now()
    if (sinceTurn() < YIELD_MS / 2) return
  }
}

/** Yields when the loop has been held for YIELD_MS or more. */
export async function turnIfDue(): Promise<void> {
  if (sinceTurn() >= YIELD_MS) await yieldTurn()
}
