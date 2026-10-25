import { useEffect, useState } from 'react'

/**
 * The Host's clock as this page sees it. Live times (how long a run or a tool has been going) are measured against the
 * Host's own record of when it began, so they read the same on every device even when a phone's clock is off: each
 * snapshot and streamed state carries the Host's time, and the page keeps the offset between that and its own clock.
 * A change of the offset under a second is noise from the network and is ignored. An older Host sends no time; the
 * offset then stays zero.
 */
let offset = 0

/** Observes a Host time received just now. */
export function observeHostTime(hostTime: string | undefined, received: number = Date.now()): void {
  if (typeof hostTime !== 'string') return
  const at = Date.parse(hostTime)
  if (!Number.isFinite(at)) return
  const next = at - received
  if (Math.abs(next - offset) >= 1000) offset = next
}

/** Now, on the Host's clock, in milliseconds. */
export const hostNow = (): number => Date.now() + offset

/** For tests: forgets the observed offset. */
export function resetHostClock(): void {
  offset = 0
}

/** Milliseconds since the epoch of an ISO time a Host recorded, or undefined when it is absent or malformed. */
export function parseTime(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : undefined
}

/** A non-negative number of milliseconds a Host recorded, or undefined. */
export function parseDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

type Listener = () => void
const seconds = new Set<Listener>()
const minutes = new Set<Listener>()
let secondTimer: ReturnType<typeof setInterval> | undefined
let minuteTimer: ReturnType<typeof setTimeout> | undefined

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

function armSeconds(): void {
  if (secondTimer !== undefined || seconds.size === 0 || hidden()) return
  secondTimer = setInterval(() => {
    for (const listener of seconds) listener()
  }, 1000)
}
function disarmSeconds(): void {
  clearInterval(secondTimer)
  secondTimer = undefined
}
/** The next whole minute of the wall clock: labels such as 14:32 or 今天 change there. */
function armMinutes(): void {
  if (minuteTimer !== undefined || minutes.size === 0 || hidden()) return
  minuteTimer = setTimeout(
    () => {
      minuteTimer = undefined
      for (const listener of minutes) listener()
      armMinutes()
    },
    60_000 - (Date.now() % 60_000) + 50,
  )
}
function disarmMinutes(): void {
  clearTimeout(minuteTimer)
  minuteTimer = undefined
}

if (typeof document !== 'undefined') {
  // A hidden page ticks for nobody; it catches up when it shows again.
  document.addEventListener('visibilitychange', () => {
    if (hidden()) {
      disarmSeconds()
      disarmMinutes()
      return
    }
    for (const listener of [...seconds, ...minutes]) listener()
    armSeconds()
    armMinutes()
  })
}

/**
 * One shared ticker for the page: `second` re-renders the caller every second (live counters), `minute` at every
 * whole minute (dates and times of day, which roll over at midnight). Only the leaf that shows the value subscribes,
 * and it stops while the page is hidden. Returns the page's clock at the last tick.
 */
export function useTicker(rate: 'second' | 'minute' | false): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (rate === false) return undefined
    const set = rate === 'second' ? seconds : minutes
    const listener = () => {
      setNow(Date.now())
    }
    set.add(listener)
    if (rate === 'second') armSeconds()
    else armMinutes()
    return () => {
      set.delete(listener)
      if (seconds.size === 0) disarmSeconds()
      if (minutes.size === 0) disarmMinutes()
    }
  }, [rate])
  return now
}
