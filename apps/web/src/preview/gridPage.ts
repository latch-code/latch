import type { GridCell } from './types.ts'

/** Preserve page geometry within the finite bridge budget; shortened values are visibly marked. */
export function gridPage(
  rowCount: number,
  columns: number,
  start: number,
  count: number,
  cellAt: (row: number, col: number) => GridCell | undefined,
): { rows: GridCell[][]; truncated: boolean } {
  const rows: GridCell[][] = [],
    end = Math.min(rowCount, start + count)
  const cellLimit = Math.floor(1_000_000 / Math.max(1, (end - start) * columns))
  let truncated = false
  const clipped = (text: string, limit: number) => {
    if (text.length <= limit) return text
    truncated = true
    let value = text.slice(0, Math.max(0, limit - 1))
    if (/[\uD800-\uDBFF]$/u.test(value)) value = value.slice(0, -1)
    return value + '…'
  }
  for (let r = start; r < end; r++) {
    const row: GridCell[] = []
    for (let c = 0; c < columns; c++) {
      const cell = cellAt(r, c) ?? { text: '' }
      const formula = cell.formula === undefined ? undefined : clipped(cell.formula, Math.floor(cellLimit / 2))
      row.push({ ...cell, text: clipped(cell.text, cellLimit - (formula?.length ?? 0)), ...(formula === undefined ? {} : { formula }) })
    }
    rows.push(row)
  }
  return { rows, truncated }
}
