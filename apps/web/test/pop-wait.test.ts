import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOTION } from '@latch/ui'
import { popWait } from '../src/shell/popWait.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A page with the system's reduced-motion preference and the 动效 setting as given. */
function page(options: { systemReduced?: boolean; motion?: string } = {}) {
  vi.stubGlobal('document', { documentElement: { dataset: options.motion ? { motion: options.motion } : {} } })
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('no-preference') ? !options.systemReduced : !!options.systemReduced,
  }))
}

describe('going back from a pushed page', () => {
  it("waits for the page's exit to play", () => {
    page()
    expect(popWait(false)).toBe(MOTION.pushExit)
    expect(popWait(false)).toBeGreaterThan(0)
  })

  it('does not wait when nothing animates: an instant change, the system asking for less motion, or 减弱 on this device', () => {
    page()
    expect(popWait(true)).toBe(0)
    page({ systemReduced: true })
    expect(popWait(false)).toBe(0)
    // The setting alone, on a system that allows motion.
    page({ motion: 'reduce' })
    expect(popWait(false)).toBe(0)
  })
})
