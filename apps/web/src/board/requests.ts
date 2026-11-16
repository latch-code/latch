import { useEffect, useRef } from 'react'
import type { BoardGroup } from '@latch/protocol'

/**
 * What the shell asks of the board from outside it: show one group (the start screen's counts) or open 新建 (⌘N on the
 * board). A request made before the board is mounted waits for it.
 */
export type BoardRequest = { kind: 'group'; group: BoardGroup } | { kind: 'new' }

const listeners = new Set<(request: BoardRequest) => void>()
let waiting: BoardRequest | null = null

export function requestBoard(request: BoardRequest): void {
  if (listeners.size === 0) {
    waiting = request
    return
  }
  for (const listener of listeners) listener(request)
}

export function useBoardRequests(handle: (request: BoardRequest) => void): void {
  const latest = useRef(handle)
  useEffect(() => {
    latest.current = handle
  })
  useEffect(() => {
    const listener = (request: BoardRequest) => {
      latest.current(request)
    }
    listeners.add(listener)
    if (waiting) {
      const request = waiting
      waiting = null
      listener(request)
    }
    return () => {
      listeners.delete(listener)
    }
  }, [])
}
