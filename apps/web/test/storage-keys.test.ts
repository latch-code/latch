import { afterEach, describe, expect, it, vi } from 'vitest'
import { readChoice } from '../src/composerChoice.ts'
import { readPending, type PendingSubmission } from '../src/core/api.ts'
import { readStorage } from '../src/core/storageKeys.ts'
import { parseModelPreferences } from '../src/modelPreferences.ts'
import { parsePreferences, storageGet } from '../src/preferences.ts'
import { readSeen } from '../src/sessions.ts'

const ORIGIN = 'http://h-host.localhost:4317'

/** A Storage over a Map; `fail` makes the named method throw, as a full or blocked storage does. */
function memoryStorage(entries: Record<string, string> = {}, fail: { setItem?: boolean; getItem?: boolean } = {}) {
  const values = new Map(Object.entries(entries))
  return {
    values,
    getItem: (key: string) => {
      if (fail.getItem) throw new DOMException('blocked', 'SecurityError')
      return values.get(key) ?? null
    },
    setItem: (key: string, value: string) => {
      if (fail.setItem) throw new DOMException('full', 'QuotaExceededError')
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('browser storage keys from before the rename', () => {
  it('moves a value only the old harness-link. name holds to latch., once, and reads it', () => {
    const storage = memoryStorage({ 'harness-link.preferences': '{"theme":"dark"}' })
    vi.stubGlobal('localStorage', storage)
    expect(readStorage('localStorage', 'latch.preferences')).toBe('{"theme":"dark"}')
    expect(Object.fromEntries(storage.values)).toEqual({ 'latch.preferences': '{"theme":"dark"}' })
    // The second read finds the new name; nothing is left to move.
    expect(readStorage('localStorage', 'latch.preferences')).toBe('{"theme":"dark"}')
    expect(readStorage('localStorage', 'latch.missing')).toBeNull()
  })

  it('keeps a value under the new name and leaves an old entry alone', () => {
    const storage = memoryStorage({ 'latch.preferences': '{"theme":"light"}', 'harness-link.preferences': '{"theme":"dark"}' })
    vi.stubGlobal('localStorage', storage)
    expect(readStorage('localStorage', 'latch.preferences')).toBe('{"theme":"light"}')
    expect(storage.values.get('harness-link.preferences')).toBe('{"theme":"dark"}')
  })

  it('moves only latch. keys, and from the same name under the old prefix', () => {
    const storage = memoryStorage({ 'harness-link.other': 'x', other: 'y' })
    vi.stubGlobal('localStorage', storage)
    expect(readStorage('localStorage', 'other')).toBe('y')
    expect(readStorage('localStorage', 'latch.preferences')).toBeNull()
    expect(storage.values.get('harness-link.other')).toBe('x')
  })

  it('reads nothing when storage is missing or refuses, and still reads the old value when the new one cannot be written', () => {
    vi.stubGlobal('sessionStorage', undefined)
    expect(readStorage('sessionStorage', 'latch.selected.x')).toBeNull()
    vi.stubGlobal('localStorage', memoryStorage({ 'harness-link.preferences': '{}' }, { getItem: true }))
    expect(readStorage('localStorage', 'latch.preferences')).toBeNull()
    const full = memoryStorage({ 'harness-link.preferences': '{"theme":"dark"}' }, { setItem: true })
    vi.stubGlobal('localStorage', full)
    expect(readStorage('localStorage', 'latch.preferences')).toBe('{"theme":"dark"}')
    // Nothing moved, so nothing was lost: the old entry is still there for the next read.
    expect(Object.fromEntries(full.values)).toEqual({ 'harness-link.preferences': '{"theme":"dark"}' })
  })

  it('keeps preferences, model choices, read markers, the composer choice and the selected session', () => {
    vi.stubGlobal('location', { origin: ORIGIN })
    const local = memoryStorage({
      'harness-link.preferences': JSON.stringify({ theme: 'dark', sendKey: 'mod-enter' }),
      'harness-link.model-preferences': JSON.stringify({ recent: ['p\u0000m'], hidden: [] }),
      [`harness-link.seen.${ORIGIN}.dev_1`]: JSON.stringify({ baseline: '2026-10-01T00:00:00.000Z', seen: { s1: 'a' } }),
      [`harness-link.composer.${ORIGIN}.dev_1`]: JSON.stringify({ mode: 'chat', harnessId: 'codex' }),
    })
    const session = memoryStorage({ [`harness-link.selected.${ORIGIN}.dev_1`]: 'task_1' })
    vi.stubGlobal('localStorage', local)
    vi.stubGlobal('sessionStorage', session)
    expect(parsePreferences(storageGet('latch.preferences'))).toMatchObject({ theme: 'dark', sendKey: 'mod-enter' })
    expect(parseModelPreferences(storageGet('latch.model-preferences'))).toEqual({ recent: ['p\u0000m'], hidden: [] })
    expect(readSeen(`latch.seen.${ORIGIN}.dev_1`)).toMatchObject({ baseline: '2026-10-01T00:00:00.000Z', seen: { s1: 'a' } })
    expect(readChoice('dev_1')).toEqual({ mode: 'chat', harnessId: 'codex' })
    expect(readStorage('sessionStorage', `latch.selected.${ORIGIN}.dev_1`)).toBe('task_1')
    expect([...local.values.keys()].filter(key => key.startsWith('harness-link.'))).toEqual([])
    expect([...session.values.keys()]).toEqual([`latch.selected.${ORIGIN}.dev_1`])
  })

  it('keeps a submission the Host has not confirmed, with its requestId, so a retry cannot run it twice', () => {
    const submission: PendingSubmission = { requestId: 'request-1', prompt: 'Summarise the notes', sessionId: 'task_1' }
    const local = memoryStorage({ [`harness-link.pending.${ORIGIN}.dev_1`]: JSON.stringify(submission) })
    vi.stubGlobal('localStorage', local)
    expect(readPending(`latch.pending.${ORIGIN}.dev_1`)).toEqual(submission)
    expect([...local.values.keys()]).toEqual([`latch.pending.${ORIGIN}.dev_1`])
  })
})
