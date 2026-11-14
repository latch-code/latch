/** Schedules a callback for the next animation frame; absent where there are no frames (a test, a worker). */
export type FrameScheduler = ((run: () => void) => unknown) | undefined

const nextFrame: FrameScheduler = typeof requestAnimationFrame === 'function' ? run => requestAnimationFrame(run) : undefined

/**
 * Runs `draw` at most once per animation frame, however many times it is asked for within one; with nothing to schedule
 * on it runs at once. A hidden page has no frames, so nothing is drawn until it is shown again, and then once.
 */
export function frameGate(draw: () => void, schedule: FrameScheduler = nextFrame): () => void {
  let waiting = false
  return () => {
    if (!schedule) return draw()
    if (waiting) return
    waiting = true
    schedule(() => {
      waiting = false
      draw()
    })
  }
}
