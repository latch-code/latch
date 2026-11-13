import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlashHistory } from '../src/core/slashHistory.ts'
import { forgetStoredDrafts } from '../src/core/sessionDrafts.ts'

const storage = () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    get length() {
      return values.size
    },
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
  })
  return values
}
afterEach(() => vi.unstubAllGlobals())

describe('recent slash choices', () => {
  it('keeps eight unique IDs per device and scopes Harness commands without storing prompts', () => {
    const values = storage()
    const first = new SlashHistory('https://host', 'device-a')
    for (let index = 0; index < 10; index++) first.record(`command:c${index}`, 'codex')
    expect(first.ids('codex')).toEqual(['c9', 'c8', 'c7', 'c6', 'c5', 'c4', 'c3', 'c2'].map(name => 'command:' + name))
    first.record('command:c4', 'codex')
    expect(first.ids('codex')[0]).toBe('command:c4')
    first.record('template:review', undefined)
    expect(first.ids('pi')).toEqual(['template:review'])
    expect(new SlashHistory('https://host', 'device-b').ids('codex')).toEqual([])
    expect([...values.values()].every(value => !value.includes('prompt'))).toBe(true)
    first.record('command:run with arguments', 'codex')
    expect(first.ids('codex')).not.toContain('command:run with arguments')
  })
  it('clears on device replacement and sign-out and prevents a late write from restoring old IDs', () => {
    storage()
    const old = new SlashHistory('https://host', 'old')
    const next = new SlashHistory('https://host', 'next')
    old.record('action:clear', undefined)
    next.record('template:review', undefined)
    forgetStoredDrafts('https://host', 'next')
    old.record('action:new', undefined)
    expect(old.ids(undefined)).toEqual([])
    expect(next.ids(undefined)).toEqual(['template:review'])
    forgetStoredDrafts('https://host')
    next.record('action:new', undefined)
    expect(next.ids(undefined)).toEqual([])
    expect(new SlashHistory('https://host', 'next').ids(undefined)).toEqual([])
  })
  it('removes readable IDs even when storage cannot write a revocation marker', () => {
    const values = storage()
    const old = new SlashHistory('https://full-host', 'old')
    old.record('action:clear', undefined)
    const write = localStorage.setItem
    localStorage.setItem = () => {
      throw new DOMException('Full', 'QuotaExceededError')
    }
    forgetStoredDrafts('https://full-host')
    expect([...values.keys()].filter(key => key.startsWith('latch.slash-recent.'))).toEqual([])
    localStorage.setItem = write
    old.record('action:new', undefined)
    expect(old.ids(undefined)).toEqual([])
  })
  it('revokes another window when quota blocks a new epoch but still permits shrinking the device key', async () => {
    const values = storage()
    const origin = 'https://shared-quota-host'
    forgetStoredDrafts(origin, 'old')
    const old = new SlashHistory(origin, 'old')
    old.record('action:clear', undefined)
    const write = localStorage.setItem
    localStorage.setItem = (key, value) => {
      if (key.startsWith('latch.slash-forgotten.')) throw new DOMException('Full', 'QuotaExceededError')
      write(key, value)
    }
    vi.resetModules()
    const anotherWindow = await import('../src/core/slashHistory.ts')
    anotherWindow.forgetSlashHistory(origin)
    localStorage.setItem = write
    old.record('action:new', undefined)
    expect(old.ids(undefined)).toEqual([])
    expect([...values.keys()].filter(key => key.startsWith('latch.slash-recent.'))).toEqual([])
  })
})
