/// <reference path="./vendor.d.ts" />
import { parse } from 'papaparse'
import type { GridCell, SheetInfo } from './types.ts'
export function parseCsv(
  data: ArrayBuffer,
  delimiter?: string,
): { info: SheetInfo; rows: GridCell[][]; truncated: boolean; replacement: boolean; delimiter: string } {
  const bytes = new Uint8Array(data)
  if (bytes.length > 50 * 1024 * 1024) throw new Error('file-too-large')
  const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8',
    text = new TextDecoder(encoding).decode(bytes)
  const rows: GridCell[][] = []
  let cells = 0,
    truncated = false,
    columns = 0
  const result = parse(text, {
    ...(delimiter ? { delimiter } : {}),
    skipEmptyLines: true,
    dynamicTyping: false,
    step: (result, parser) => {
      const values = result.data
      if (rows.length >= 1_000_000 || cells + values.length > 2_000_000) {
        truncated = true
        parser.abort()
        return
      }
      if (values.length > 200) truncated = true
      const row = values.slice(0, 200).map(value => ({ text: value.slice(0, 32767) }))
      if (values.some(value => value.length > 32767)) truncated = true
      cells += row.length
      columns = Math.max(columns, row.length)
      rows.push(row)
    },
  })
  return {
    rows,
    truncated,
    replacement: text.includes('\ufffd'),
    delimiter: result?.meta?.delimiter ?? delimiter ?? ',',
    info: {
      id: 0,
      name: '表格',
      rows: rows.length,
      cols: columns,
      hidden: false,
      merges: [],
      colWidths: Array.from({ length: columns }, () => 120),
      frozen: { rows: 1, cols: 0 },
    },
  }
}
