import { afterEach, expect, it, vi } from 'vitest'
import { readHiddenRelayIds, setRelayHidden } from '../src/settings/relayVisibility.ts'

afterEach(() => vi.unstubAllGlobals())

it('stores only relay IDs and scopes the visibility preference to each Host', () => {
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  const relayId = 'a'.repeat(32)
  setRelayHidden('local', relayId, true)
  setRelayHidden('local', 'unexpected-file-content', true)
  expect([...storage]).toEqual([['latch.hidden-relays.local', JSON.stringify([relayId])]])
  expect([...readHiddenRelayIds('other')]).toEqual([])
  expect([...readHiddenRelayIds('local')]).toEqual([relayId])
  setRelayHidden('local', relayId, false)
  expect([...readHiddenRelayIds('local')]).toEqual([])
  expect(storage.size).toBe(0)
})

it('keeps the preference for this page session when browser storage refuses writes', () => {
  const relayId = 'b'.repeat(32)
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {
      throw new Error('storage unavailable')
    },
    removeItem: () => {
      throw new Error('storage unavailable')
    },
  })
  setRelayHidden('blocked-storage', relayId, true)
  expect(readHiddenRelayIds('blocked-storage').has(relayId)).toBe(true)
  setRelayHidden('blocked-storage', relayId, false)
  expect(readHiddenRelayIds('blocked-storage').has(relayId)).toBe(false)
})
