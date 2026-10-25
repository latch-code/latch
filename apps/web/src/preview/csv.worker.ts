import { parseCsv } from './csv.ts'
import { isFrameCommand } from './types.ts'
import type { GridCell } from './types.ts'
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage: (value: unknown) => void }
let rows: GridCell[][] = []
scope.onmessage = event => {
  const value = event.data
  if (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && 'type' in value
    && value.type === 'init'
    && 'data' in value
    && value.data instanceof ArrayBuffer
  ) {
    try {
      const result = parseCsv(
        value.data,
        'delimiter' in value && typeof value.delimiter === 'string' && ['\t', ',', ';', '|'].includes(value.delimiter)
          ? value.delimiter
          : undefined,
      )
      rows = result.rows
      scope.postMessage({
        type: 'rendered',
        kind: 'csv',
        sheets: [result.info],
        truncated: result.truncated,
        replacement: result.replacement,
        delimiter: result.delimiter,
      })
    } catch {
      scope.postMessage({ type: 'error', code: 'render-failed' })
    }
    return
  }
  if (isFrameCommand(value) && value.type === 'sheet-page') {
    const selected: GridCell[][] = []
    let chars = 0,
      truncated = false
    for (const row of rows.slice(value.start, value.start + value.count)) {
      if (chars + row.reduce((n, cell) => n + cell.text.length, 0) > 1_000_000) {
        truncated = true
        break
      }
      selected.push(row)
      chars += row.reduce((n, cell) => n + cell.text.length, 0)
    }
    scope.postMessage({ type: 'sheet-page', sheet: 0, start: value.start, rows: selected, truncated })
  }
}
