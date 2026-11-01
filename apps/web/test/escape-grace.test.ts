import { describe, expect, it } from 'vitest'
import { escapeIsLeftover, overlayDismissed } from '../src/escapeGrace.ts'

describe('Esc after an overlay', () => {
  it('holds back presses that follow on, for as long as they keep coming', () => {
    overlayDismissed(1000)
    expect(escapeIsLeftover({ repeat: false }, 1200)).toBe(true)
    expect(escapeIsLeftover({ repeat: false }, 1600)).toBe(true)
    expect(escapeIsLeftover({ repeat: false }, 2000)).toBe(true)
    expect(escapeIsLeftover({ repeat: false }, 2600)).toBe(false)
  })

  it('never counts a held key', () => {
    overlayDismissed(0)
    expect(escapeIsLeftover({ repeat: true }, 10_000)).toBe(true)
    expect(escapeIsLeftover({ repeat: false }, 10_000)).toBe(false)
  })
})
