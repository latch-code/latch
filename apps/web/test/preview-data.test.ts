import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { assertPresentationComplexity, inspectZip, readOfficeZip } from '../src/preview/zip.ts'
import { isFrameCommand, isFrameEvent } from '../src/preview/types.ts'
import { parseCsv } from '../src/preview/csv.ts'
import { sheetPage, type ParsedSheet } from '../src/preview/xlsx.ts'
describe('document data boundaries', () => {
  it('refuses excessive presentation shapes before DOM parsing, for arbitrary prefixes and inherited layouts', () => {
    expect(() => assertPresentationComplexity({ 'ppt/slides/slide1.xml': strToU8('<p:sp/>'.repeat(10_000)) })).toThrow(
      'document-too-complex',
    )
    expect(() => assertPresentationComplexity({ 'ppt/slideMasters/master.xml': strToU8('<自定:pic/>'.repeat(5001)) })).toThrow(
      'document-too-complex',
    )
    expect(() => assertPresentationComplexity({ 'ppt/slideLayouts/layout.xml': strToU8('<a:x/>'.repeat(50_001)) })).toThrow(
      'document-too-complex',
    )
    expect(() => assertPresentationComplexity({ 'ppt/slides/slide1.xml': strToU8('<p:sp/>'.repeat(5000)) })).not.toThrow()
    expect(() =>
      assertPresentationComplexity(
        Object.fromEntries(Array.from({ length: 11 }, (_, i) => ['ppt/slides/slide' + i + '.xml', strToU8('<p:sp/>'.repeat(5000))])),
      ),
    ).toThrow('document-too-complex')
  })
  it('keeps every workbook row reachable when long cells exhaust a message budget', () => {
    const sheet: ParsedSheet = {
      info: { id: 0, name: 'Data', rows: 128, cols: 200, hidden: false, merges: [], colWidths: [], frozen: { rows: 1, cols: 1 } },
      cells: new Map(
        Array.from({ length: 128 }, (_, r) => [
          r,
          new Map(Array.from({ length: 200 }, (_, c) => [c, { text: 'x'.repeat(256), formula: '1+'.repeat(128) }])),
        ]),
      ),
    }
    for (const start of [0, 64]) {
      const result = sheetPage(sheet, start, 64)
      expect(result.rows).toHaveLength(64)
      expect(result.truncated).toBe(true)
      expect(result.rows.flat().reduce((total, cell) => total + cell.text.length + (cell.formula?.length ?? 0), 0)).toBeLessThanOrEqual(
        1_000_000,
      )
      expect(isFrameEvent({ type: 'sheet-page', sheet: 0, start, ...result })).toBe(true)
      expect(result.rows.at(-1)?.[0]?.text.endsWith('…')).toBe(true)
    }
    expect(sheet.info.rows).toBe(128)
    const detailed = sheetPage(sheet, 127, 1)
    expect(detailed.truncated).toBe(false)
    expect(detailed.rows[0]?.[0]?.text).toBe('x'.repeat(256))
  })
  it('accepts bounded normal ZIPs and rejects traversal, huge declarations, encryption and missing directories before inflation', () => {
    const zip = zipSync({ 'word/document.xml': strToU8('<document/>') })
    expect(() => inspectZip(zip)).not.toThrow()
    expect(new TextDecoder().decode(readOfficeZip(zip.buffer as ArrayBuffer)['word/document.xml'])).toBe('<document/>')
    const forged = zipSync({ payload: new Uint8Array(65_536) }, { level: 9 }),
      forgedView = new DataView(forged.buffer)
    for (let i = 0; i < forged.length - 30; i++) {
      const signature = forgedView.getUint32(i, true)
      if (signature === 0x04034b50) forgedView.setUint32(i + 22, 1, true)
      if (signature === 0x02014b50) forgedView.setUint32(i + 24, 1, true)
    }
    expect(() => readOfficeZip(forged.buffer as ArrayBuffer)).toThrow('zip-refused')
    expect(() => inspectZip(zipSync({ '../escape': strToU8('bad') }))).toThrow('zip-refused')
    const oversized = zip.slice(),
      view = new DataView(oversized.buffer)
    for (let i = 0; i < oversized.length - 46; i++)
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 33 * 1024 * 1024, true)
        break
      }
    expect(() => inspectZip(oversized)).toThrow('zip-refused')
    const encrypted = zip.slice(),
      encryptedView = new DataView(encrypted.buffer)
    for (let i = 0; i < encrypted.length - 46; i++)
      if (encryptedView.getUint32(i, true) === 0x02014b50) {
        encryptedView.setUint16(i + 8, 1, true)
        break
      }
    expect(() => inspectZip(encrypted)).toThrow('zip-refused')
    expect(() => inspectZip(zip.subarray(0, zip.length - 22))).toThrow('zip-refused')
  })
  it('rejects extra fields, invalid indices, huge cell pages and prototype-shaped values on the bridge', () => {
    expect(isFrameCommand({ type: 'sheet-page', sheet: 0, start: 0, count: 1000 })).toBe(true)
    expect(isFrameCommand({ type: 'zoom', percent: 125 })).toBe(true)
    expect(isFrameEvent({ type: 'view', fit: false, zoomPercent: 125 })).toBe(true)
    for (const value of [
      { type: 'sheet-page', sheet: 0, start: 0, count: 1001 },
      { type: 'page', index: -1 },
      { type: 'fit', value: true, url: 'https://invalid.example/' },
      { type: 'page', index: NaN },
      { type: 'zoom', percent: 401 },
      { type: 'zoom', percent: 9 },
      { type: 'zoom', percent: 100.5 },
      { type: 'zoom', percent: 100, url: 'x' },
    ])
      expect(isFrameCommand(value)).toBe(false)
    expect(isFrameEvent({ type: 'sheet-page', sheet: 0, start: 0, rows: [[{ text: 'x', formula: '1+1' }]] })).toBe(true)
    expect(isFrameEvent({ type: 'sheet-page', sheet: 0, start: 0, rows: [[{ text: 'x'.repeat(32768) }]] })).toBe(false)
    expect(isFrameEvent({ type: 'view', fit: true, zoomPercent: Infinity })).toBe(false)
    expect(isFrameEvent({ type: 'error', code: '<script>bad</script>' })).toBe(false)
    expect(isFrameEvent({ type: 'initialized', constructor: { prototype: { polluted: true } } })).toBe(false)
    expect(isFrameEvent({ type: 'html', blocked: 4 })).toBe(true)
    for (const blocked of [-1, 0.5, Number.POSITIVE_INFINITY, 100_001, '4']) expect(isFrameEvent({ type: 'html', blocked })).toBe(false)
    expect(isFrameEvent({ type: 'html', blocked: 0, credential: 'unexpected' })).toBe(false)
    expect(isFrameEvent({ type: 'html', blocked: 0, scripts: true, canvas: { width: 1920, height: 1080 } })).toBe(true)
    for (const canvas of [{ width: 0, height: 720 }, { width: 8000, height: 720 }, { width: 1280.5, height: 720 }, { width: 1280 }, 'tall'])
      expect(isFrameEvent({ type: 'html', blocked: 0, canvas })).toBe(false)
    expect(isFrameEvent({ type: 'html', blocked: 0, canvas: { width: 1280, height: 720, depth: 1 } })).toBe(false)
    expect(isFrameEvent({ type: 'html', blocked: 0, scripts: false })).toBe(false)
    expect(isFrameEvent({ type: 'html', blocked: 0, pages: { index: 2, count: 3 } })).toBe(true)
    for (const pages of [
      { index: 3, count: 3 },
      { index: -1, count: 3 },
      { index: 0, count: 10_000 },
      { index: 0 },
      2,
      { index: 0, count: 1, html: '' },
    ])
      expect(isFrameEvent({ type: 'html', blocked: 0, pages })).toBe(false)
  })
  it('parses quoted CSV as strings, supports UTF16/TSV, never evaluates formulas and marks bounded columns', () => {
    const value = parseCsv(strToU8('name,value\n"a,b","=HYPERLINK(1)"\n').buffer as ArrayBuffer)
    expect(value.rows[1]).toEqual([{ text: 'a,b' }, { text: '=HYPERLINK(1)' }])
    const content = '\ufeff中文\t42\n',
      utf16 = new Uint8Array(content.length * 2),
      view = new DataView(utf16.buffer)
    for (let i = 0; i < content.length; i++) view.setUint16(i * 2, content.charCodeAt(i), true)
    expect(parseCsv(utf16.buffer, '\t').rows[0]).toEqual([{ text: '中文' }, { text: '42' }])
    expect(parseCsv(strToU8(Array.from({ length: 201 }, () => 'x').join(',')).buffer as ArrayBuffer).truncated).toBe(true)
  })
})
