import { describe, expect, it, vi } from 'vitest'
import { drawField, fieldFrame, fieldLinks, frameTime, FIELD_LINK, FIELD_POINTS } from '../src/shell/ParticleField.tsx'

const NOW = Date.parse('2026-10-20T09:30:00+08:00')

describe('the field behind the work panel', () => {
  it('shows the clock on a 33ms grid, and time 0 under reduced motion', () => {
    expect(frameTime(1000, false)).toBe(990)
    expect(frameTime(1010, false)).toBe(1023)
    expect(frameTime(990 + 16, false)).toBe(990)
    expect(frameTime(NOW, false) % 33).toBe(0)
    expect(frameTime(NOW, true)).toBe(0)
  })

  it('draws a frame from the seed, the size and the time alone, without Math.random', () => {
    const random = vi.spyOn(Math, 'random')
    try {
      const frame = fieldFrame(1130, 884, frameTime(NOW, false))
      expect(frame).toHaveLength(FIELD_POINTS)
      expect(fieldFrame(1130, 884, frameTime(NOW, false))).toEqual(frame)
      expect(fieldFrame(1130, 884, frameTime(NOW + 33, false))).not.toEqual(frame)
      expect(fieldFrame(1130, 884, 0, 8)).not.toEqual(fieldFrame(1130, 884, 0))
      expect(random).not.toHaveBeenCalled()
    } finally {
      random.mockRestore()
    }
  })

  it('makes every seventh point the second colour', () => {
    const hued = fieldFrame(800, 600, 0).flatMap((dot, index) => (dot.hue ? [index] : []))
    expect(hued).toEqual(Array.from({ length: Math.ceil(FIELD_POINTS / 7) }, (_, index) => index * 7))
  })

  it('drifts slowly upward and comes back in at the bottom, inside the panel at any clock', () => {
    const [width, height] = [1130, 884]
    const before = fieldFrame(width, height, 0)
    const after = fieldFrame(width, height, 1000)
    // In one second each point rises 3 to 11px and moves less than 4px sideways.
    for (const [index, dot] of after.entries()) {
      const rise = before[index]!.y - dot.y
      if (rise < 0) continue // came back in at the bottom
      expect(rise).toBeGreaterThanOrEqual(3)
      expect(rise).toBeLessThanOrEqual(11)
    }
    for (const time of [0, NOW, NOW * 3])
      for (const dot of fieldFrame(width, height, frameTime(time, false))) {
        expect(dot.x).toBeGreaterThanOrEqual(-4)
        expect(dot.x).toBeLessThan(width + 4)
        expect(dot.y).toBeGreaterThanOrEqual(-4)
        expect(dot.y).toBeLessThan(height + 4)
        expect(dot.alpha).toBeGreaterThan(0)
        expect(dot.alpha).toBeLessThanOrEqual(0.54)
      }
  })

  it('joins only near neighbours, fainter the further apart', () => {
    const dots = fieldFrame(1130, 884, frameTime(NOW, false))
    const links = fieldLinks(dots)
    expect(links.length).toBeGreaterThan(0)
    expect(links.length).toBeLessThan(5000)
    for (const [i, j, step] of links) {
      const distance = Math.hypot(dots[i]!.x - dots[j]!.x, dots[i]!.y - dots[j]!.y)
      expect(distance).toBeLessThan(FIELD_LINK)
      expect(step).toBe(Math.ceil((1 - distance / FIELD_LINK) * 8))
    }
  })

  it('paints a few hairline paths, then each point, in the theme colours', () => {
    const calls: string[] = []
    const fills: string[] = []
    const pen = {
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 1,
      globalAlpha: 1,
      clearRect: () => calls.push('clear'),
      beginPath: () => calls.push('begin'),
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => calls.push('stroke'),
      arc: () => {},
      fill() {
        calls.push('fill')
        fills.push(String(this.fillStyle))
      },
    }
    const dots = fieldFrame(1130, 884, 0)
    drawField(pen as never, dots, 1130, 884, { ink: '#5d6b86', accent: '#2461e0', strength: 1.25 })
    expect(calls[0]).toBe('clear')
    expect(calls.filter(call => call === 'stroke').length).toBeLessThanOrEqual(8)
    expect(fills).toHaveLength(FIELD_POINTS)
    expect(fills.filter(fill => fill === '#2461e0')).toHaveLength(dots.filter(dot => dot.hue).length)
    expect(pen.globalAlpha).toBe(1)
  })
})
