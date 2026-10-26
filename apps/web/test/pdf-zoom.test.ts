import { describe, expect, it } from 'vitest'
import { PDF_CSS_SCALE, pdfPercent, pdfScale, pdfZoomKey } from '../src/preview/pdfZoom.ts'

describe('PDF zoom and canvas bounds', () => {
  it('uses the actual page width in fit mode and PDF-point/CSS-pixel scaling outside fit', () => {
    expect(pdfScale(612, 792, 636, { fit: true, percent: 400 }, 1)).toBe(1)
    expect(pdfScale(612, 792, 400, { fit: false, percent: 100 }, 1)).toBe(PDF_CSS_SCALE)
    expect(pdfScale(612, 792, 400, { fit: false, percent: 200 }, 1)).toBe(PDF_CSS_SCALE * 2)
  })
  it.each([1, 2, 3])('keeps very large PDF pages inside the existing pixel budget at DPR %s', ratio => {
    const scale = pdfScale(2000, 3000, 1000, { fit: false, percent: 400 }, ratio)
    expect(2000 * 3000 * scale ** 2 * Math.min(2, ratio) ** 2).toBeLessThanOrEqual(16_000_000.000001)
    expect(Math.ceil(2000 * scale * Math.min(2, ratio)) * Math.ceil(3000 * scale * Math.min(2, ratio))).toBeLessThanOrEqual(16_000_000)
    expect(scale).toBeGreaterThan(0)
  })
  it('bounds user zoom without turning invalid dimensions into infinite virtual rows', () => {
    expect([pdfPercent(-1), pdfPercent(520), pdfPercent(NaN), pdfPercent(109.8)]).toEqual([10, 400, 100, 110])
    expect(() => pdfScale(0, 792, 400, { fit: true, percent: 100 }, 1)).toThrow('invalid-page-size')
    expect(() => pdfScale(612, Infinity, 400, { fit: false, percent: 100 }, 1)).toThrow('invalid-page-size')
  })
  it('handles only document zoom chords and leaves composition and alternate shortcuts alone', () => {
    const event = { key: '=', metaKey: true, ctrlKey: false, altKey: false }
    expect(pdfZoomKey(event)).toBe('in')
    expect(pdfZoomKey({ ...event, key: '-' })).toBe('out')
    expect(pdfZoomKey({ ...event, key: '0' })).toBe('fit')
    expect(pdfZoomKey({ ...event, metaKey: false, ctrlKey: true, key: '+' })).toBe('in')
    expect(pdfZoomKey({ ...event, metaKey: false })).toBeUndefined()
    expect(pdfZoomKey({ ...event, altKey: true })).toBeUndefined()
    expect(pdfZoomKey({ ...event, isComposing: true })).toBeUndefined()
  })
})
