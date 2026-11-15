import { useEffect, useState, useSyncExternalStore } from 'react'

/** How long new choices take no press, so a click meant for what was there before cannot land on them. */
const ARMING_MS = 320

/** A document-level key must never act on a conversation covered by another page. */
export function cardTakesKeys(card: HTMLElement | null, target?: EventTarget | null): boolean {
  if (card === null || card.closest('[inert]') || !card.checkVisibility({ visibilityProperty: true })) return false
  // Native modal inertness is implicit and does not add an inert attribute to the retained page.
  const active = target instanceof Element ? target : document.activeElement
  if (document.querySelector('dialog:modal') && !active?.closest('dialog:modal')?.contains(card)) return false
  // A workbench's first card can offer page keys, but another card with focus owns its own choices.
  return !(
    target instanceof Element
    && target.closest('.work-decision, .approval-panel, .question-card, [data-work-decision-navigation]')
    && !card.contains(target)
  )
}

/** Counts each time the conversation comes back into view (from under a page, from a hidden tab). */
let shown = 0
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const read = () => shown

/**
 * The conversation is on screen again: every card's arming starts over, so a click meant for what was there a moment
 * ago (a plugin page that took the person back here, say) cannot land on 允许.
 */
export function conversationShown(): void {
  shown++
  for (const listener of listeners) listener()
}

/** True once `id` has been on screen for the arming time; every new request, and every return to view, starts over. */
export function useArmed(id: string): boolean {
  const epoch = useSyncExternalStore(subscribe, read, read)
  const key = `${id}\n${epoch}`
  const [armed, setArmed] = useState<string | null>(null)
  useEffect(() => {
    const timer = setTimeout(() => setArmed(key), ARMING_MS)
    return () => clearTimeout(timer)
  }, [key])
  return armed === key
}
