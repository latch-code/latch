import { parseCsv } from './csv.ts'
import { isFrameCommand } from './types.ts'
import type { GridCell } from './types.ts'
import { gridPage } from './gridPage.ts'
const scope = globalThis as unknown as { onmessage: ((event: MessageEvent<unknown>) => void) | null; postMessage: (value: unknown) => void }
let rows: GridCell[][] = []
let columns = 0
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
      columns = result.info.cols
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
    scope.postMessage({
      type: 'sheet-page',
      sheet: 0,
      start: value.start,
      ...gridPage(rows.length, columns, value.start, value.count, (row, col) => rows[row]?.[col]),
    })
  }
}
