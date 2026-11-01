import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { InlineNotice } from '@latch/ui'
import { useViewerMenu, useViewerQuote } from './viewerActions.tsx'
import type { GridCell, SheetInfo } from './types.ts'
import { boundedQuoteText, columnLabel, type PreviewQuote } from './quote.ts'
export type LoadRows = (start: number, count: number, signal?: AbortSignal) => Promise<GridCell[][]>
const PAGE_ROWS = 64
export interface SheetView {
  top: number
  left: number
  active: { row: number; col: number }
  anchor: { row: number; col: number }
  widths: number[]
  frozen: boolean
}
export function SheetGrid({
  sheet,
  load,
  view,
  onView,
  onQuote,
}: {
  sheet: SheetInfo
  load: LoadRows
  view?: SheetView
  onView?(view: SheetView): void
  onQuote?(quote: PreviewQuote): void
}) {
  const clamp = (value?: { row: number; col: number }) => ({
    row: Math.max(0, Math.min(sheet.rows - 1, value?.row ?? 0)),
    col: Math.max(0, Math.min(sheet.cols - 1, value?.col ?? 0)),
  })
  const scroll = useRef<HTMLDivElement>(null),
    [cache, setCache] = useState<Map<number, GridCell[][]>>(new Map()),
    [error, setError] = useState(''),
    [active, setActive] = useState(() => clamp(view?.active)),
    [anchor, setAnchor] = useState(() => clamp(view?.anchor)),
    [widths, setWidths] = useState(() =>
      Array.from({ length: sheet.cols }, (_, index) => view?.widths[index] ?? sheet.colWidths[index] ?? 120),
    ),
    [frozen, setFrozen] = useState(view?.frozen ?? true),
    [busy, setBusy] = useState(false)
  const operation = useRef<AbortController | undefined>(undefined),
    viewCallback = useRef(onView)
  viewCallback.current = onView
  const frozenRows = frozen ? Math.min(sheet.rows, sheet.frozen.rows || 1, 10) : 0,
    frozenCols = frozen ? Math.min(sheet.cols, sheet.frozen.cols || 1, 200) : 0
  useLayoutEffect(() => {
    if (scroll.current && view) {
      scroll.current.scrollTop = view.top
      scroll.current.scrollLeft = view.left
    }
  }, [])
  const saveView = () =>
    viewCallback.current?.({
      top: scroll.current?.scrollTop ?? 0,
      left: scroll.current?.scrollLeft ?? 0,
      active,
      anchor,
      widths,
      frozen,
    })
  useLayoutEffect(() => {
    saveView()
    return saveView
  }, [active, anchor, widths, frozen])
  useEffect(() => () => operation.current?.abort(), [])
  const rows = useVirtualizer({ count: sheet.rows, getScrollElement: () => scroll.current, estimateSize: () => 32, overscan: 4 }),
    cols = useVirtualizer({
      horizontal: true,
      count: sheet.cols,
      getScrollElement: () => scroll.current,
      estimateSize: index => widths[index] ?? 120,
      overscan: 2,
    })
  const visible = rows.getVirtualItems(),
    pageStarts = [...new Set([...(frozenRows > 0 ? [0] : []), ...visible.map(row => Math.floor(row.index / PAGE_ROWS) * PAGE_ROWS)])].join(
      ',',
    )
  useEffect(() => {
    const controller = new AbortController()
    for (const start of pageStarts.split(',').filter(Boolean).map(Number))
      if (!cache.has(start))
        void load(start, PAGE_ROWS, controller.signal)
          .then(value => {
            if (!controller.signal.aborted)
              setCache(previous => {
                const next = new Map(previous)
                next.set(start, value)
                while (next.size > 5) {
                  const disposable = [...next.keys()].find(key => !pageStarts.split(',').map(Number).includes(key))
                  if (disposable === undefined) break
                  next.delete(disposable)
                }
                return next
              })
          })
          .catch(() => {
            if (!controller.signal.aborted) setError('部分行无法读取，请重新打开文件后重试。')
          })
    return () => controller.abort()
  }, [load, pageStarts])
  useEffect(() => cols.measure(), [widths, cols])
  const get = (r: number, c: number) => cache.get(Math.floor(r / PAGE_ROWS) * PAGE_ROWS)?.[r % PAGE_ROWS]?.[c]
  const left = (index: number) => widths.slice(0, index).reduce((n, width) => n + width, 0)
  const select = (row: number, col: number, extend: boolean) => {
    const next = { row: Math.max(0, Math.min(sheet.rows - 1, row)), col: Math.max(0, Math.min(sheet.cols - 1, col)) }
    setActive(next)
    if (!extend) setAnchor(next)
    rows.scrollToIndex(next.row, { align: 'auto' })
    cols.scrollToIndex(next.col, { align: 'auto' })
  }
  const selectionText = async (limit: number, signal: AbortSignal) => {
    const a = Math.min(active.row, anchor.row),
      b = Math.max(active.row, anchor.row),
      c = Math.min(active.col, anchor.col),
      d = Math.max(active.col, anchor.col)
    if ((b - a + 1) * (d - c + 1) > limit) throw new Error('请缩小选区后重试。')
    const values: GridCell[][] = []
    for (let start = Math.floor(a / PAGE_ROWS) * PAGE_ROWS; start <= b; start += PAGE_ROWS) {
      const page = cache.get(start) ?? (await load(start, PAGE_ROWS, signal))
      if (signal.aborted) throw new Error('cancelled')
      for (let r = Math.max(a, start); r <= Math.min(b, start + PAGE_ROWS - 1); r++) values.push(page[r - start] ?? [])
    }
    const text = values
      .map(row =>
        Array.from({ length: d - c + 1 }, (_, i) => row[c + i]?.text ?? '')
          .map(text => (/[\t\r\n"]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text))
          .join('\t'),
      )
      .join('\n')
    if (text.length > 1_000_000) throw new Error('选区文字过多，请缩小选区。')
    return { text, cells: { sheet: sheet.name, start: [a, c] as [number, number], end: [b, d] as [number, number] } }
  }
  const useSelection = async (action: 'copy' | 'quote') => {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    try {
      const result = await selectionText(action === 'copy' ? 10_000 : 2000, controller.signal)
      if (controller.signal.aborted) return
      if (action === 'copy') await navigator.clipboard.writeText(result.text)
      else if (result.text.trim()) onQuote?.({ text: boundedQuoteText(result.text), cells: result.cells })
      else {
        setError('选区没有文字内容。')
        return
      }
      setError('')
    } catch {
      if (!controller.signal.aborted) setError('暂时无法读取选区，请缩小选区后重试。')
    } finally {
      if (!controller.signal.aborted) setBusy(false)
      if (operation.current === controller) operation.current = undefined
    }
  }
  const pinned = frozenRows
  const visibleRows = [
    ...Array.from({ length: pinned }, (_, index) => ({ index, start: index * 32, key: `pinned-${index}` })),
    ...visible.filter(row => row.index >= pinned),
  ]
  const visibleCols = [
    ...new Set([...Array.from({ length: frozenCols }, (_, i) => i), ...cols.getVirtualItems().map(col => col.index)]),
  ].sort((a, b) => a - b)
  const unavailable = busy || !sheet.rows || !sheet.cols
  useViewerQuote(onQuote ? !unavailable : undefined, () => {
    void useSelection('quote')
  })
  useViewerMenu([
    {
      id: 'copy-range',
      label: '复制选区',
      ...(unavailable ? { disabledReason: '选区还没有读完' } : {}),
      onSelect: () => {
        void useSelection('copy')
      },
    },
    {
      id: 'frozen',
      label: '冻结首行首列',
      checked: frozen,
      onSelect: () => {
        setFrozen(value => !value)
      },
    },
  ])
  return (
    <div className="sheet-grid">
      <div className="sheet-grid-actions">
        <span>
          {columnLabel(active.col)}
          {active.row + 1}
          {active.row !== anchor.row || active.col !== anchor.col ? ` : ${columnLabel(anchor.col)}${anchor.row + 1}` : ''}
        </span>
      </div>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <div
        ref={scroll}
        onScroll={saveView}
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
            void useSelection('copy')
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
                data-frozen={col < frozenCols ? '' : undefined}
                style={{ left: left(col) + 48, width: widths[col] ?? 120 }}>
                {columnLabel(col)}
                <button
                  type="button"
                  role="separator"
                  aria-label={`调整 ${columnLabel(col)} 列宽`}
                  aria-orientation="vertical"
                  aria-valuenow={widths[col] ?? 120}
                  aria-valuemin={16}
                  aria-valuemax={1000}
                  onKeyDown={event => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
                    event.preventDefault()
                    event.stopPropagation()
                    setWidths(previous => {
                      const next = [...previous]
                      next[col] =
                        event.key === 'Home'
                          ? (sheet.colWidths[col] ?? 120)
                          : Math.max(
                              16,
                              Math.min(1000, (previous[col] ?? 120) + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 32 : 8)),
                            )
                      return next
                    })
                  }}
                  onPointerDown={event => {
                    const start = event.clientX,
                      width = widths[col] ?? 120
                    event.currentTarget.setPointerCapture(event.pointerId)
                    const element = event.currentTarget
                    const move = (pointer: PointerEvent) =>
                      setWidths(previous => {
                        const next = [...previous]
                        next[col] = Math.max(16, Math.min(1000, width + pointer.clientX - start))
                        return next
                      })
                    const up = () => {
                      element.removeEventListener('pointermove', move)
                      element.removeEventListener('pointerup', up)
                      element.removeEventListener('pointercancel', up)
                      element.removeEventListener('lostpointercapture', up)
                    }
                    element.addEventListener('pointermove', move)
                    element.addEventListener('pointerup', up)
                    element.addEventListener('pointercancel', up)
                    element.addEventListener('lostpointercapture', up)
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
                    data-frozen={col < frozenCols ? '' : undefined}
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
