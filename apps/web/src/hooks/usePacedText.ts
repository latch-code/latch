import { useEffect, useState } from 'react'
import { motionAllowed, watchMotion } from '@latch/ui'
import { CATCH_UP_CHARS, FenceTracker, revealCut, revealRate, revealStep } from '../core/pacedText.ts'

const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

/**
 * The part of a reply's text to draw now. While the reply is live, text that just arrived shows at an even pace over
 * about 180 ms instead of in jumps, from one animation-frame timer and with no element per character. Far behind, on a
 * hidden page, with reduced motion or once the reply is no longer live it is the whole text, drawn in the same render
 * that received it. What is drawn only ever grows. Display only: the message, what is copied, and the settled render
 * are the text itself.
 */
export function usePacedText(text: string, live: boolean): string {
  const paced = live && motionAllowed() && !hidden()
  // A reply's first words are paced like the rest; one already long when the page first shows it is not replayed.
  // One mutable record for the timer and the render: `shown` moves between renders, and each move asks for a redraw.
  const [pace] = useState(() => {
    const first = paced && text.length <= CATCH_UP_CHARS ? 0 : text.length
    return { shown: first, target: text.length, drawn: first, rate: 0, frame: 0, at: 0 }
  })
  const [, redraw] = useState(0)
  const [fence] = useState(() => new FenceTracker())

  useEffect(() => {
    pace.target = text.length
    const rate = paced ? revealRate(pace.shown, pace.target) : undefined
    if (rate === undefined) {
      cancelAnimationFrame(pace.frame)
      pace.frame = 0
      // Only a reveal that was under way has something left to draw; otherwise this render already drew the text.
      if (paced && pace.shown < pace.target) redraw(count => count + 1)
      pace.shown = pace.target
      return
    }
    pace.rate = rate
    if (pace.frame !== 0) return
    pace.at = performance.now()
    const tick = (now: number) => {
      pace.shown = hidden() ? pace.target : revealStep(pace.shown, pace.target, pace.rate, now - pace.at)
      pace.at = now
      pace.frame = pace.shown < pace.target ? requestAnimationFrame(tick) : 0
      redraw(count => count + 1)
    }
    pace.frame = requestAnimationFrame(tick)
  }, [text, paced, pace])

  useEffect(() => {
    if (!live) return
    // Reveal the rest when the page stops pacing, including when the preference changes mid-reply.
    const caughtUp = () => {
      if ((motionAllowed() && !hidden()) || pace.shown >= pace.target) return
      pace.shown = pace.target
      redraw(count => count + 1)
    }
    document.addEventListener('visibilitychange', caughtUp)
    const unwatch = watchMotion(caughtUp)
    return () => {
      unwatch()
      document.removeEventListener('visibilitychange', caughtUp)
      cancelAnimationFrame(pace.frame)
      pace.frame = 0
    }
  }, [live, pace])

  if (!paced || pace.shown >= text.length) {
    pace.drawn = text.length
    return text
  }
  // Never less than was already drawn: text shown whole stays, also where a code line would otherwise wait for its end.
  const cut = Math.max(revealCut(text, pace.shown, fence), Math.min(pace.drawn, text.length))
  pace.drawn = cut
  return cut >= text.length ? text : text.slice(0, cut)
}
