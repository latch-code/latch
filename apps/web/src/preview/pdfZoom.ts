export const PDF_CSS_SCALE = 96 / 72
export interface PdfZoom {
  fit: boolean
  percent: number
}
export const pdfPercent = (value: number): number => Math.max(10, Math.min(400, Math.round(Number.isFinite(value) ? value : 100)))
/** PDF points become CSS pixels at 96/72; each visible canvas keeps the existing 16-million-pixel budget. */
export function pdfScale(width: number, height: number, available: number, zoom: PdfZoom, ratio: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error('invalid-page-size')
  const requested = zoom.fit ? Math.max(100, available - 24) / width : PDF_CSS_SCALE * (pdfPercent(zoom.percent) / 100)
  const pixels = Math.max(1, Math.min(2, ratio || 1))
  let maximum = Math.min(requested, Math.sqrt(16_000_000 / (width * height)) / pixels, 16_384 / (Math.max(width, height) * pixels))
  if (!(maximum > 0)) throw new Error('invalid-page-size')
  const fits = (scale: number) => Math.ceil(width * scale * pixels) * Math.ceil(height * scale * pixels) <= 16_000_000
  if (fits(maximum)) return maximum
  // Canvas dimensions round up independently; the continuous area bound alone can overshoot by a few thousand pixels.
  let minimum = 0
  for (let i = 0; i < 32; i++) {
    const middle = (maximum + minimum) / 2
    if (fits(middle)) minimum = middle
    else maximum = middle
  }
  return minimum
}
export function pdfZoomKey(event: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  isComposing?: boolean
}): 'in' | 'out' | 'fit' | undefined {
  if (event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey)) return
  if (event.key === '+' || event.key === '=') return 'in'
  if (event.key === '-') return 'out'
  if (event.key === '0') return 'fit'
}
