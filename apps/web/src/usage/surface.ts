import { useSyncExternalStore } from 'react'
import { api } from '../core/api.ts'

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

/**
 * Someone looks at limits: asks the Host to read those that are missing or old, in the background, for every Harness or
 * for `ids`; what arrives comes with the catalog. The Host keeps the limits on how often; a refusal says nothing here.
 * Resolves with the Harnesses the Host asked.
 */
export async function refreshLimits(ids?: readonly string[], retry = false): Promise<string[]> {
  try {
    const answer = await api<{ asked?: unknown }>('quota/refresh', {
      method: 'POST',
      body: { ...(ids ? { ids: [...ids] } : {}), ...(retry ? { retry } : {}) },
    })
    return Array.isArray(answer.asked) ? answer.asked.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
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
