import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { Meter } from '../src/index.ts'
import { emulateMedia } from './helpers.ts'

const cells = (meter: Element) => Array.from(meter.querySelectorAll<HTMLElement>('.ui-meter-cell'))

describe('meter', () => {
  it('reads as a meter with its label and the value in words', async () => {
    const screen = await render(<Meter label="上下文" value={62} max={128} valueText="62k / 128k" />)
    const meter = screen.getByRole('meter', { name: '上下文' })
    await expect.element(meter).toHaveAttribute('aria-valuenow', '62')
    await expect.element(meter).toHaveAttribute('aria-valuemax', '128')
    await expect.element(meter).toHaveAttribute('aria-valuetext', '62k / 128k')
  })

  it('fills whole cells: the share rounded to the nearest cell, at least one above zero, never past the end', async () => {
    const screen = await render(
      <div>
        <Meter label="半" value={62} max={128} />
        <Meter label="少" value={1} max={1000} />
        <Meter label="空" value={0} max={128} />
        <Meter label="满" value={300} max={128} />
        <Meter label="八格" value={3} max={8} cells={8} />
      </div>,
    )
    const filled = (name: string) => cells(screen.getByRole('meter', { name }).element()).map(cell => cell.hasAttribute('data-on'))
    expect(filled('半').filter(Boolean)).toHaveLength(6)
    expect(filled('半').slice(0, 6).every(Boolean)).toBe(true)
    expect(filled('少').filter(Boolean)).toHaveLength(1)
    expect(filled('空').filter(Boolean)).toHaveLength(0)
    expect(filled('满')).toEqual(Array.from({ length: 12 }, () => true))
    await expect.element(screen.getByRole('meter', { name: '满' })).toHaveAttribute('aria-valuenow', '128')
    expect(filled('八格')).toHaveLength(8)
  })

  it('lays its cells on whole pixels at a fixed pitch, in both sizes', async () => {
    const screen = await render(
      <div>
        <Meter label="小" value={5} max={12} />
        <Meter label="大" value={5} max={12} size="md" />
      </div>,
    )
    for (const [name, width, pitch, height] of [
      ['小', 3, 4, 8],
      ['大', 14, 16, 10],
    ] as const) {
      const meter = screen.getByRole('meter', { name }).element()
      const boxes = cells(meter).map(cell => cell.getBoundingClientRect())
      const start = meter.getBoundingClientRect().left
      expect(boxes.map(box => box.width)).toEqual(boxes.map(() => width))
      expect(boxes.map(box => box.height)).toEqual(boxes.map(() => height))
      expect(boxes.map(box => box.left - start)).toEqual(boxes.map((_, index) => index * pitch))
      expect(boxes.every(box => Number.isInteger(box.left - start))).toBe(true)
      expect(meter.getBoundingClientRect().width).toBe(12 * pitch - (pitch - width))
    }
  })

  it('draws filled cells in meter ink on the track grey, in both themes, and never animates', async () => {
    const screen = await render(<Meter label="上下文" value={6} max={12} />)
    const meter = screen.getByRole('meter', { name: '上下文' }).element()
    const [on, off] = [meter.querySelector('[data-on]')!, meter.querySelector('.ui-meter-cell:not([data-on])')!]
    const colours = () => [getComputedStyle(on).backgroundColor, getComputedStyle(off).backgroundColor]
    expect(colours()).toEqual(['rgb(69, 69, 78)', 'rgba(18, 18, 28, 0.11)'])
    await emulateMedia({ 'prefers-color-scheme': 'dark' }, () => {
      expect(colours()).toEqual(['rgb(182, 182, 191)', 'rgba(255, 255, 255, 0.11)'])
    })
    expect([getComputedStyle(on).transitionDuration, getComputedStyle(on).animationName]).toEqual(['0s', 'none'])
    expect(meter.getAnimations({ subtree: true })).toEqual([])
  })
})
