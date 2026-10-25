import { useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button, InlineNotice } from '@latch/ui'
import type { GridCell, SheetInfo } from './types.ts'
export type LoadRows = (start: number, count: number, signal?: AbortSignal) => Promise<GridCell[][]>
const columnLabel = (index: number) => {
  let n = index + 1,
    label = ''
  while (n) {
    n--
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26)
  }
  return label
}
export function SheetGrid({ sheet, load }: { sheet: SheetInfo; load: LoadRows }) {
  const scroll = useRef<HTMLDivElement>(null),
    [cache, setCache] = useState<Map<number, GridCell[][]>>(new Map()),
    [error, setError] = useState(''),
    [active, setActive] = useState({ row: 0, col: 0 }),
    [anchor, setAnchor] = useState({ row: 0, col: 0 }),
    [widths, setWidths] = useState(sheet.colWidths)
  const rows = useVirtualizer({ count: sheet.rows, getScrollElement: () => scroll.current, estimateSize: () => 32, overscan: 4 }),
    cols = useVirtualizer({
      horizontal: true,
      count: sheet.cols,
      getScrollElement: () => scroll.current,
      estimateSize: index => widths[index] ?? 120,
      overscan: 2,
    })
  const visible = rows.getVirtualItems(),
    pageStarts = [...new Set([...(sheet.frozen.rows > 0 ? [0] : []), ...visible.map(row => Math.floor(row.index / 1000) * 1000)])].join(',')
  useEffect(() => {
    const controller = new AbortController()
    for (const start of pageStarts.split(',').filter(Boolean).map(Number))
      if (!cache.has(start))
        void load(start, 1000, controller.signal)
          .then(value => {
            if (!controller.signal.aborted)
              setCache(previous => {
                const next = new Map(previous)
                next.set(start, value)
                while (next.size > 5) next.delete(next.keys().next().value!)
                return next
              })
          })
          .catch(() => {
            if (!controller.signal.aborted) setError('部分行无法读取，请重新打开文件后重试。')
          })
    return () => controller.abort()
  }, [load, pageStarts])
  useEffect(() => cols.measure(), [widths, cols])
  const get = (r: number, c: number) => cache.get(Math.floor(r / 1000) * 1000)?.[r % 1000]?.[c]
  const left = (index: number) => widths.slice(0, index).reduce((n, width) => n + width, 0)
  const select = (row: number, col: number, extend: boolean) => {
    const next = { row: Math.max(0, Math.min(sheet.rows - 1, row)), col: Math.max(0, Math.min(sheet.cols - 1, col)) }
    setActive(next)
    if (!extend) setAnchor(next)
    rows.scrollToIndex(next.row, { align: 'auto' })
    cols.scrollToIndex(next.col, { align: 'auto' })
  }
  const copy = async () => {
    const a = Math.min(active.row, anchor.row),
      b = Math.max(active.row, anchor.row),
      c = Math.min(active.col, anchor.col),
      d = Math.max(active.col, anchor.col)
    if ((b - a + 1) * (d - c + 1) > 10_000) {
      setError('一次最多复制 10,000 个单元格，请缩小选区。')
      return
    }
    try {
      const values: GridCell[][] = []
      for (let start = Math.floor(a / 1000) * 1000; start <= b; start += 1000) {
        const page = cache.get(start) ?? (await load(start, 1000))
        for (let r = Math.max(a, start); r <= Math.min(b, start + 999); r++) values.push(page[r - start] ?? [])
      }
      const text = values
        .map(row =>
          Array.from({ length: d - c + 1 }, (_, i) => row[c + i]?.text ?? '')
            .map(text => (/[\t\r\n"]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text))
            .join('\t'),
        )
        .join('\n')
      if (text.length > 1_000_000) {
        setError('选区文字过多，请缩小选区。')
        return
      }
      await navigator.clipboard.writeText(text)
      setError('')
    } catch {
      setError('未能复制选区，请重试。')
    }
  }
  const pinned = Math.min(sheet.frozen.rows, 10)
  const visibleRows = [
    ...Array.from({ length: pinned }, (_, index) => ({ index, start: index * 32, key: `pinned-${index}` })),
    ...visible.filter(row => row.index >= pinned),
  ]
  const visibleCols = [
    ...new Set([...Array.from({ length: Math.min(sheet.frozen.cols, 200) }, (_, i) => i), ...cols.getVirtualItems().map(col => col.index)]),
  ].sort((a, b) => a - b)
  return (
    <div className="sheet-grid">
      <div className="sheet-grid-actions">
        <span>
          {columnLabel(active.col)}
          {active.row + 1}
          {active.row !== anchor.row || active.col !== anchor.col ? ` : ${columnLabel(anchor.col)}${anchor.row + 1}` : ''}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void copy()
          }}>
          复制选区
        </Button>
      </div>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <div
        ref={scroll}
        className="sheet-grid-viewport"
        role="grid"
        aria-label={sheet.name}
        aria-rowcount={sheet.rows + 1}
        aria-colcount={sheet.cols + 1}
        tabIndex={0}
        onKeyDown={event => {
          const movement: Record<string, [number, number]> = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] }
          const delta = movement[event.key]
          if (delta) {
            event.preventDefault()
            select(active.row + delta[0], active.col + delta[1], event.shiftKey)
          } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
            event.preventDefault()
            void copy()
          }
        }}>
        <div className="sheet-grid-canvas" style={{ height: rows.getTotalSize() + 32, width: cols.getTotalSize() + 48 }}>
          <div className="sheet-grid-header" role="row" aria-rowindex={1} style={{ width: cols.getTotalSize() + 48 }}>
            <div className="sheet-row-number" role="columnheader" />
            {visibleCols.map(col => (
              <div
                role="columnheader"
                key={col}
                className="sheet-column-header"
                style={{ left: left(col) + 48, width: widths[col] ?? 120 }}>
                {columnLabel(col)}
                <button
                  type="button"
                  role="separator"
                  aria-label={`调整 ${columnLabel(col)} 列宽`}
                  aria-orientation="vertical"
                  onPointerDown={event => {
                    const start = event.clientX,
                      width = widths[col] ?? 120
                    event.currentTarget.setPointerCapture(event.pointerId)
                    const element = event.currentTarget
                    const move = (pointer: PointerEvent) =>
                      setWidths(previous => {
                        const next = [...previous]
                        next[col] = Math.max(40, Math.min(1000, width + pointer.clientX - start))
                        return next
                      })
                    const up = () => {
                      element.removeEventListener('pointermove', move)
                      element.removeEventListener('pointerup', up)
                    }
                    element.addEventListener('pointermove', move)
                    element.addEventListener('pointerup', up)
                  }}
                />
              </div>
            ))}
          </div>
          {visibleRows.map(row => (
            <div
              className="sheet-grid-row"
              role="row"
              data-frozen-row={row.index < pinned ? '' : undefined}
              aria-rowindex={row.index + 2}
              key={row.key}
              style={{ top: row.start + 32, width: cols.getTotalSize() + 48 }}>
              <div className="sheet-row-number" role="rowheader">
                {row.index + 1}
              </div>
              {visibleCols.map(col => {
                const merge = sheet.merges.find(
                  ([r, c, endRow, endCol]) => row.index >= r && row.index <= endRow && col >= c && col <= endCol,
                )
                if (merge && (merge[0] !== row.index || merge[1] !== col)) return null
                const cell = get(row.index, col),
                  selected =
                    row.index >= Math.min(active.row, anchor.row)
                    && row.index <= Math.max(active.row, anchor.row)
                    && col >= Math.min(active.col, anchor.col)
                    && col <= Math.max(active.col, anchor.col)
                return (
                  <div
                    key={col}
                    role="gridcell"
                    aria-colindex={col + 2}
                    aria-rowspan={merge ? merge[2] - merge[0] + 1 : undefined}
                    aria-colspan={merge ? merge[3] - merge[1] + 1 : undefined}
                    aria-selected={selected}
                    className="sheet-grid-cell"
                    data-numeric={cell?.numeric ? '' : undefined}
                    data-frozen={col < sheet.frozen.cols ? '' : undefined}
                    style={{
                      left: left(col) + 48,
                      width: merge ? widths.slice(merge[1], merge[3] + 1).reduce((sum, width) => sum + width, 0) : (widths[col] ?? 120),
                      height: merge ? (merge[2] - merge[0] + 1) * 32 : 32,
                    }}
                    title={cell?.formula ? `公式：${cell.formula}（显示缓存值）` : cell?.text}
                    onClick={event => {
                      select(row.index, col, event.shiftKey)
                      scroll.current?.focus({ preventScroll: true })
                    }}>
                    {cell?.text ?? ''}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
