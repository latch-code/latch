import { useSyncExternalStore } from 'react'

export type UsageView = 'limits' | 'usage'

/**
 * What the one 额度与用量 surface is asked to show: a view, and optionally one Harness's limits (from its composer chip) or
 * one model service's usage (from a session on it). Without a scope it shows every Harness and every service.
 */
export interface UsageRequest {
  view: UsageView
  harnessId?: string
  providerId?: string
}

let current: UsageRequest | null = null
const listeners = new Set<() => void>()
const notify = () => {
  for (const listener of listeners) listener()
}

/** Opens the surface (or points the open one at another scope); every entry, the chip and the shortcut call this. */
export function openUsage(request: UsageRequest = { view: 'limits' }): void {
  current = request
  notify()
}

export function closeUsage(): void {
  if (current === null) return
  current = null
  notify()
}

/** The shortcut: opens it on every Harness's limits, or closes it when it is open. */
export function toggleUsage(): void {
  if (current) closeUsage()
  else openUsage()
}

export function useUsageRequest(): UsageRequest | null {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => current,
    () => null,
  )
}
