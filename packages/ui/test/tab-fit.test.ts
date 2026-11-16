import { describe, expect, it } from 'vitest'
import { fitTabs } from '../src/tabFit.ts'

const tabs = (selected: number, available: number, widths = [60, 60, 60, 60, 60]) =>
  fitTabs({ widths, selected, available, gap: 2, more: 40 })

describe('which panel tabs stand in the row', () => {
  it('keeps every tab, with its label, while they all fit', () => {
    expect(tabs(0, 308)).toEqual([0, 1, 2, 3, 4])
  })

  it('moves the trailing tabs into the menu, never narrowing one to its glyph', () => {
    // 307 is one short of all five: four stand beside the menu's button.
    expect(tabs(0, 307)).toEqual([0, 1, 2, 3])
    expect(tabs(2, 230)).toEqual([0, 1, 2])
  })

  it('always keeps the selected tab in the row, in the last place', () => {
    expect(tabs(4, 307)).toEqual([0, 1, 2, 4])
    expect(tabs(4, 120)).toEqual([4])
  })

  it('shows the first tab when nothing fits and nothing is selected', () => {
    expect(tabs(-1, 10)).toEqual([0])
  })

  it('lets a wide selected tab displace as many tabs before it as it needs', () => {
    expect(fitTabs({ widths: [60, 90, 60, 160, 60], selected: 3, available: 330, gap: 2, more: 40 })).toEqual([0, 3])
  })
})
