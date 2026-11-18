/// <reference path="./vendor.d.ts" />
import { format, isDateFormat } from 'numfmt'
import { parseXml, resolvePart, xmlText } from './zip.ts'
import type { GridCell, SheetInfo } from './types.ts'
import { gridPage } from './gridPage.ts'
export interface ParsedSheet {
  info: SheetInfo
  cells: Map<number, Map<number, GridCell>>
}
const descendants = (element: Document | Element, name: string) => Array.from(element.getElementsByTagNameNS('*', name))
const number = (value: string | null | undefined, fallback = 0) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
function address(value: string): [number, number] | undefined {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/u.exec(value)
  if (!match) return
  let col = 0
  for (const c of match[1]!) col = col * 26 + c.charCodeAt(0) - 64
  const row = Number(match[2]) - 1
  return row < 1_048_576 && col <= 16_384 ? [row, col - 1] : undefined
}
const BUILTIN: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'm/d/yy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yy h:mm',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@',
}
export function parseXlsx(files: Record<string, Uint8Array>): { sheets: ParsedSheet[]; truncated: boolean } {
  const load = (name: string) => (files[name] ? parseXml(xmlText(files[name]!)) : undefined)
  const book = load('xl/workbook.xml'),
    rels = load('xl/_rels/workbook.xml.rels')
  if (!book || !rels) throw new Error('invalid-file')
  const targets = new Map(
    descendants(rels, 'Relationship')
      .filter(rel => rel.getAttribute('TargetMode') !== 'External')
      .map(rel => [rel.getAttribute('Id'), resolvePart('xl/workbook.xml', rel.getAttribute('Target') ?? '')]),
  )
  const shared = load('xl/sharedStrings.xml'),
    strings = shared
      ? descendants(shared, 'si').map(item =>
          descendants(item, 't')
            .map(t => t.textContent ?? '')
            .join('')
            .slice(0, 32767),
        )
      : []
  if (strings.length > 1_000_000) throw new Error('zip-refused')
  const styles = load('xl/styles.xml'),
    formats = { ...BUILTIN }
  for (const item of styles ? descendants(styles, 'numFmt') : [])
    formats[number(item.getAttribute('numFmtId'))] = (item.getAttribute('formatCode') ?? 'General').slice(0, 1000)
  const cellXfs = styles ? descendants(styles, 'cellXfs')[0] : undefined,
    formatIds = cellXfs ? Array.from(cellXfs.children).map(xf => number(xf.getAttribute('numFmtId'))) : []
  const date1904 = ['1', 'true'].includes(descendants(book, 'workbookPr')[0]?.getAttribute('date1904') ?? '')
  let total = 0,
    truncated = false
  const sheetNodes = descendants(book, 'sheet')
  if (sheetNodes.length > 100) truncated = true
  const sheets = sheetNodes.slice(0, 100).map((node, id): ParsedSheet => {
    const path = targets.get(
        node.getAttribute('r:id') ?? node.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'),
      ),
      doc = path ? load(path) : undefined
    const name = node.getAttribute('name')
    const info: SheetInfo = {
        id,
        name: (name ?? `工作表 ${id + 1}`).slice(0, 200),
        ...(name === null ? { unnamed: true } : {}),
        rows: 0,
        cols: 0,
        hidden: ['hidden', 'veryHidden'].includes(node.getAttribute('state') ?? ''),
        merges: [],
        colWidths: [],
        frozen: { rows: 1, cols: 1 },
      },
      cells = new Map<number, Map<number, GridCell>>()
    if (!doc) return { info, cells }
    const dimension = descendants(doc, 'dimension')[0]?.getAttribute('ref')?.split(':').at(-1),
      last = dimension && address(dimension)
    if (last) {
      info.rows = Math.min(1_000_000, last[0] + 1)
      info.cols = Math.min(200, last[1] + 1)
      if (last[0] >= 1_000_000 || last[1] >= 200) truncated = true
    }
    let cutoff = 1_000_000
    for (const cell of descendants(doc, 'c')) {
      const at = address(cell.getAttribute('r') ?? '')
      if (!at) continue
      const [row, col] = at
      if (total >= 2_000_000) cutoff = Math.min(cutoff, row)
      if (row >= 1_000_000 || col >= 200 || total >= 2_000_000) {
        truncated = true
        continue
      }
      total++
      info.rows = Math.max(info.rows, row + 1)
      info.cols = Math.max(info.cols, col + 1)
      const type = cell.getAttribute('t'),
        raw = descendants(cell, 'v')[0]?.textContent ?? '',
        formula = descendants(cell, 'f')[0]?.textContent?.slice(0, 8192)
      let text =
          type === 's'
            ? (strings[number(raw)] ?? '')
            : type === 'inlineStr'
              ? descendants(cell, 't')
                  .map(t => t.textContent ?? '')
                  .join('')
              : type === 'b'
                ? raw === '1'
                  ? 'TRUE'
                  : 'FALSE'
                : raw,
        numeric = false
      const noCachedValue = Boolean(formula && !descendants(cell, 'v').length)
      if (noCachedValue) text = '无缓存值'
      if (!type || type === 'n') {
        const n = Number(raw)
        if (raw !== '' && Number.isFinite(n)) {
          numeric = true
          const fmt = formats[formatIds[number(cell.getAttribute('s'))] ?? 0] ?? 'General'
          try {
            text = format(fmt, date1904 && isDateFormat(fmt) ? n + 1462 : n)
          } catch {
            text = raw
          }
        }
      }
      let rowCells = cells.get(row)
      if (!rowCells) {
        rowCells = new Map()
        cells.set(row, rowCells)
      }
      rowCells.set(col, {
        text: text.slice(0, 32767),
        ...(numeric ? { numeric: true } : {}),
        ...(formula ? { formula } : {}),
        ...(noCachedValue ? { noCachedValue: true } : {}),
      })
    }
    info.rows = Math.min(info.rows, cutoff)
    for (const item of descendants(doc, 'mergeCell').slice(0, 2000)) {
      const [a, b] = (item.getAttribute('ref') ?? '').split(':'),
        first = a && address(a),
        last = b && address(b)
      if (first && last && last[0] < 1_000_000 && last[1] < 200) info.merges.push([first[0], first[1], last[0], last[1]])
    }
    for (const item of descendants(doc, 'col')) {
      const min = Math.max(0, number(item.getAttribute('min')) - 1),
        max = Math.min(199, number(item.getAttribute('max')) - 1),
        width = Math.max(16, Math.min(1000, number(item.getAttribute('width'), 12) * 7 + 5))
      for (let col = min; col <= max; col++) info.colWidths[col] = width
    }
    info.colWidths = Array.from({ length: info.cols }, (_, i) => info.colWidths[i] ?? 100)
    const pane = descendants(doc, 'pane')[0]
    if (pane?.getAttribute('state')?.startsWith('frozen'))
      info.frozen = {
        rows: Math.min(1000, Math.max(0, Math.floor(number(pane.getAttribute('ySplit'))))),
        cols: Math.min(200, Math.max(0, Math.floor(number(pane.getAttribute('xSplit'))))),
      }
    return { info, cells }
  })
  return { sheets, truncated }
}
export function sheetPage(sheet: ParsedSheet, start: number, count: number): { rows: GridCell[][]; truncated: boolean } {
  return gridPage(sheet.info.rows, sheet.info.cols, start, count, (row, col) => sheet.cells.get(row)?.get(col))
}
