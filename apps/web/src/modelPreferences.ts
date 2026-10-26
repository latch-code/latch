import { useSyncExternalStore } from 'react'
import type { ModelRef } from '@latch/protocol'
import { storageGet, storageSet } from './preferences.ts'
export interface ModelPreferences {
  recent: string[]
  hidden: string[]
}
const KEY = 'latch.model-preferences',
  EMPTY: ModelPreferences = { recent: [], hidden: [] }
export const modelKey = (model: ModelRef) => `${model.providerId}\u0000${model.model}`
export function parseModelPreferences(raw: string | null): ModelPreferences {
  try {
    const value: unknown = JSON.parse(raw ?? 'null')
    if (!value || typeof value !== 'object') return EMPTY
    const item = value as Record<string, unknown>
    const list = (entry: unknown, max: number) =>
      Array.isArray(entry)
        ? [...new Set(entry.filter((key): key is string => typeof key === 'string' && key.length > 0 && key.length <= 1024))].slice(0, max)
        : []
    return { recent: list(item.recent, 5), hidden: list(item.hidden, 500) }
  } catch {
    return EMPTY
  }
}
let current: ModelPreferences | undefined
const listeners = new Set<() => void>()
const snapshot = () => (current ??= parseModelPreferences(storageGet(KEY)))
function write(next: ModelPreferences) {
  current = next
  storageSet(KEY, JSON.stringify(next))
  for (const listener of listeners) listener()
}
export const getModelPreferences = snapshot
export function rememberModel(key: string) {
  const value = snapshot()
  write({ ...value, recent: [key, ...value.recent.filter(item => item !== key)].slice(0, 5) })
}
export function hideModel(key: string, hidden: boolean) {
  const value = snapshot()
  write({ ...value, hidden: hidden ? [...new Set([...value.hidden, key])].slice(-500) : value.hidden.filter(item => item !== key) })
}
export function useModelPreferences(): ModelPreferences {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot,
    () => EMPTY,
  )
}
/** Literal subsequence matching tolerates punctuation and abbreviated model names. */
export function fuzzyModelMatch(label: string, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase().replace(/\s+/gu, ''),
    text = label.toLocaleLowerCase()
  let index = 0
  for (const char of needle) {
    index = text.indexOf(char, index)
    if (index < 0) return false
    index++
  }
  return true
}
