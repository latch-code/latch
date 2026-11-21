import { readStorage } from '../core/storageKeys.ts'

const memory = new Map<string, ReadonlySet<string>>()
const storageKey = (hostId: string) => `latch.hidden-relays.${hostId}`
const isRelayId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value)

export function readHiddenRelayIds(hostId: string): ReadonlySet<string> {
  const current = memory.get(hostId)
  if (current) return current
  try {
    const value: unknown = JSON.parse(readStorage('localStorage', storageKey(hostId)) ?? 'null')
    if (Array.isArray(value)) return new Set(value.filter(isRelayId))
  } catch {
    // A malformed preference does not hide anything.
  }
  return new Set()
}

export function setRelayHidden(hostId: string, relayId: string, hidden: boolean): ReadonlySet<string> {
  const ids = new Set(readHiddenRelayIds(hostId))
  if (!isRelayId(relayId)) return ids
  if (hidden) ids.add(relayId)
  else ids.delete(relayId)
  try {
    if (ids.size) localStorage.setItem(storageKey(hostId), JSON.stringify([...ids]))
    else localStorage.removeItem(storageKey(hostId))
    memory.delete(hostId)
  } catch {
    memory.set(hostId, ids)
  }
  return ids
}
