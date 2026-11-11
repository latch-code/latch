import { useSyncExternalStore } from 'react'

/**
 * When the person last saved a file of a session from this page, so results checked before it (a commit's hooks in
 * 交付) can say they need checking again. Memory only, this page only.
 */
const saved = new Map<string, number>()
const listeners = new Set<() => void>()

export function notePersonEdit(sessionId: string, at = Date.now()): void {
  saved.set(sessionId, at)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The time of the session's last saved edit from this page; undefined before any. */
export function usePersonEditAt(sessionId: string | undefined): number | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (sessionId === undefined ? undefined : saved.get(sessionId)),
    () => undefined,
  )
}

/** A result checked at `checkedAt` predates the person's last edit. */
export const needsRecheck = (checkedAt: number | undefined, editedAt: number | undefined) =>
  checkedAt !== undefined && editedAt !== undefined && editedAt > checkedAt
