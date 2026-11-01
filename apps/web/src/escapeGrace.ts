const GRACE_MS = 500

let until = 0

// Any other key means the reader has moved on, and the next Esc is meant.
if (typeof document !== 'undefined')
  document.addEventListener(
    'keydown',
    event => {
      if (event.key !== 'Escape') until = 0
    },
    true,
  )

/** An overlay was put away. Esc pressed on from here is still aimed at it, not at what now has the keys. */
export function overlayDismissed(now = performance.now()): void {
  until = now + GRACE_MS
}

/**
 * Whether an Esc that would stop a run or refuse a request is really the tail of dismissing an overlay, or a held key.
 * Each such press extends the grace, so tapping on through it never reaches the destructive handler.
 */
export function escapeIsLeftover(event: { repeat: boolean }, now = performance.now()): boolean {
  if (now < until) {
    until = now + GRACE_MS
    return true
  }
  return event.repeat
}
