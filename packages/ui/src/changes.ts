import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react'

/**
 * The page's resynchronization epoch: a value that changes whenever the state on screen is established again rather
 * than changed as it happened (the first load, a reconnect, a switch to another session). One-shot cross-fades (a
 * count's new number, a row's new status, a process row's new glyph and words) play only for a change made while the
 * epoch stayed the same, so never on a first render, a resynchronization or a session switch; without a provider they
 * never play.
 */
export const LiveChanges = createContext<string | number | null>(null)

/**
 * Motion is allowed unless the person asked for less: 减弱 on this device (data-motion="reduce" on the root) or the
 * system's reduced-motion preference. One-shot cross-fades and every scripted move play only then; every script that
 * moves something asks here, never the media query alone.
 */
export const motionAllowed = (): boolean => {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduce') return false
  return typeof matchMedia !== 'function' || matchMedia('(prefers-reduced-motion: no-preference)').matches
}

/**
 * The page is frozen for a capture (data-capture="still" on the root, set by the visual tests): what moves by itself
 * (the faces of 我的 Agent, the background layer) holds its still frame. It is its own attribute, so the 动效 setting,
 * which writes and removes data-motion, never clears it.
 */
export const captureStill = (): boolean => typeof document !== 'undefined' && document.documentElement.dataset.capture === 'still'

/**
 * Calls `changed` when `motionAllowed` or `captureStill` may answer differently: the system's preference flipped, or
 * the root's data-motion or data-capture changed. Returns the unsubscribe.
 */
export function watchMotion(changed: () => void): () => void {
  const media = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined
  media?.addEventListener('change', changed)
  const attributes = typeof MutationObserver === 'function' ? new MutationObserver(changed) : undefined
  attributes?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion', 'data-capture'] })
  return () => {
    media?.removeEventListener('change', changed)
    attributes?.disconnect()
  }
}

/** 动效 on this device: 减弱 puts data-motion="reduce" on the root, 跟随系统 removes it. Nothing else is touched. */
export function setReducedMotion(reduce: boolean): void {
  const root = document.documentElement
  if (reduce) root.dataset.motion = 'reduce'
  else delete root.dataset.motion
}

/**
 * Calls `onChange(previous, live, appeared)` after a render in which `value` changed. `live` is true when the page saw
 * the change as it happened (the epoch is the one of the previous render) and motion is allowed, which is when a
 * one-shot may play; otherwise the change shows at once. `from` is the value before this component mounted, for one
 * that appears because of a change (a count shown only above zero): the change from it is reported after the first
 * render, with `appeared` true, since the old value was not on screen.
 */
export function useLiveChange<T>(value: T, onChange: (previous: T, live: boolean, appeared: boolean) => void, from?: T): void {
  const epoch = useContext(LiveChanges)
  const last = useRef({ value: from === undefined ? value : from, epoch, appeared: from !== undefined })
  useLayoutEffect(() => {
    const previous = last.current
    last.current = { value, epoch, appeared: false }
    if (Object.is(previous.value, value)) return
    onChange(previous.value, epoch !== null && previous.epoch === epoch && motionAllowed(), previous.appeared)
  })
}

/**
 * The value `value` had before its last change, when the page saw that change happen (the epoch stayed the same);
 * otherwise, and after a resynchronization, undefined. A parent that shows something only for some values (a row with
 * its count only while the count is above zero) passes it as the `from` of what it mounts, so the arrival plays like
 * any change seen live, and never after a first load or a resynchronization.
 */
export function useLivePrevious<T>(value: T): T | undefined {
  const epoch = useContext(LiveChanges)
  const [seen, setSeen] = useState<{ value: T; epoch: string | number | null; previous: T | undefined }>({
    value,
    epoch,
    previous: undefined,
  })
  if (Object.is(seen.value, value) && seen.epoch === epoch) return seen.previous
  // Stored during render (React's pattern for information from previous renders), so the child mounted in this very
  // render already receives it.
  const next = { value, epoch, previous: epoch !== null && seen.epoch === epoch ? seen.value : undefined }
  setSeen(next)
  return next.previous
}
