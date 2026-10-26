/**
 * Browser storage keys are named `latch.<name>`. Before the rename they were `harness-link.<name>`: preferences, model
 * choices, read markers, the composer's choice, the selected session and a submission the Host has not confirmed. A
 * value only the old name holds moves to the new name the first time it is read, so nobody loses one of them.
 */
const KEY_PREFIX = 'latch.'
const LEGACY_KEY_PREFIX = 'harness-link.'

type StorageKind = 'localStorage' | 'sessionStorage'

/**
 * The value under `key`. When only the name it had before the rename holds one, that value is copied to `key` and the
 * old entry removed; a value under the new name always wins and the old entry is then left alone. Storage that is
 * missing or throws reads as null; a full storage keeps the old entry and still returns its value.
 */
export function readStorage(kind: StorageKind, key: string): string | null {
  try {
    const storage = globalThis[kind]
    const value = storage.getItem(key) ?? null
    if (value !== null || !key.startsWith(KEY_PREFIX)) return value
    const legacyKey = LEGACY_KEY_PREFIX + key.slice(KEY_PREFIX.length)
    const legacy = storage.getItem(legacyKey) ?? null
    if (legacy === null) return null
    try {
      storage.setItem(key, legacy)
      storage.removeItem(legacyKey)
    } catch {
      /* Full or read-only storage: the old entry stays and is read again next time. */
    }
    return legacy
  } catch {
    return null
  }
}
