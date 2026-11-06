import { describe, expect, it } from 'vitest'
import { emulateMedia } from './helpers.ts'

const matches = (query: string) => matchMedia(query).matches

// Each check holds only where the system preference differs from the emulated one, as on a Mac in dark mode: there a
// page that loses the emulation falls back to the system and every later light check in the run fails.
describe('emulated media', () => {
  it('returns to the light scheme after emulating the dark one', async () => {
    expect(matches('(prefers-color-scheme: light)')).toBe(true)
    await emulateMedia({ 'prefers-color-scheme': 'dark' }, () => {
      expect(matches('(prefers-color-scheme: dark)')).toBe(true)
    })
    expect(matches('(prefers-color-scheme: light)')).toBe(true)
    expect(matches('(prefers-reduced-motion: no-preference)')).toBe(true)
  })

  it('keeps the light scheme while emulating reduced motion, and full motion afterwards', async () => {
    await emulateMedia({ 'prefers-reduced-motion': 'reduce' }, () => {
      expect(matches('(prefers-reduced-motion: reduce)')).toBe(true)
      expect(matches('(prefers-color-scheme: light)')).toBe(true)
    })
    expect(matches('(prefers-reduced-motion: no-preference)')).toBe(true)
    expect(matches('(prefers-color-scheme: light)')).toBe(true)
  })

  it('restores the emulation when the check inside throws', async () => {
    await expect(
      emulateMedia({ 'prefers-color-scheme': 'dark' }, () => {
        throw new Error('failed check')
      }),
    ).rejects.toThrow('failed check')
    expect(matches('(prefers-color-scheme: light)')).toBe(true)
  })
})
