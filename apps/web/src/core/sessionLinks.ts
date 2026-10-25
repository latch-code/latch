import type { AppSnapshot } from '@latch/protocol'
import { useSyncExternalStore } from 'react'

/**
 * Where a refused confirmation's 「查看会话」 and 「停止会话」 lead: the workspace provides them while it is mounted, so
 * the card in a settings page and the dock outside the workspace reach the same sessions.
 */
export interface SessionLinks {
  snapshot: Pick<AppSnapshot, 'tasks' | 'catalog'>
  open: (sessionId: string) => void
  stop: (sessionId: string) => Promise<void>
}

let links: SessionLinks | null = null
const listeners = new Set<() => void>()

export function provideSessionLinks(next: SessionLinks | null): void {
  links = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useSessionLinks(): SessionLinks | null {
  return useSyncExternalStore(
    subscribe,
    () => links,
    () => null,
  )
}
