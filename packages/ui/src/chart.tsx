import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cx } from './internal.ts'

/*
 * Charts drawn as inline SVG at the pixel width they are given, so a bar's edge and a 1px rule stay crisp at any size.
 * Series take the chart colours in order (--chart-1…4), never cycled and never a state colour; every series is named
 * beside its colour, and every mark tells its exact figures on hover or focus. A chart keeps its height while it
 * measures and while its data changes, so nothing around it moves.
 */

const SERIES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)'] as const
/** The colour of series `index`; past the fourth, the rest share a quiet ink rather than a new hue. */
export const chartColour = (index: number): string => SERIES[index] ?? 'var(--faint)'

function useWidth<T extends Element>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return undefined
    const measure = () => setWidth(Math.floor(element.getBoundingClientRect().width))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

/** A round top for an axis: 1, 2 or 5 times a power of ten, at least the value. */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power
  return 10 * power
}

/** An axis label's anchor: kept inside the chart at either end. */
function anchorAt(x: number, width: number): { x: number; textAnchor: 'start' | 'middle' | 'end' } {
  if (x > width - 22) return { x: width, textAnchor: 'end' }
  return { x, textAnchor: 'middle' }
}

/** Which of `count` labels to write so about `room` fit: the first, the last, and evenly between. */
export function labelled(count: number, room: number): Set<number> {
  if (count <= room) return new Set(Array.from({ length: count }, (_, index) => index))
  const every = Math.ceil((count - 1) / Math.max(1, room - 1))
  const shown = new Set<number>([count - 1])
  for (let index = 0; index < count; index += every) if (count - 1 - index >= every || index === 0) shown.add(index)
  return shown
}

/** Lengths laid end to end from 0, two apart: where each starts. */
function laid(lengths: readonly number[]): number[] {
  const starts: number[] = []
  lengths.reduce((at, length) => {
    starts.push(at)
    return at + length + 2
  }, 0)
  return starts
}

interface ChartTipLine {
  label: string
  value: string
  /** Series index for the swatch; absent: no swatch (a total). */
  series?: number
}

/** The hover card: a title and one line a figure. Placed beside the mark, kept inside the chart. */
function Tip({ x, title, lines, width }: { x: number; title: string; lines: readonly ChartTipLine[]; width: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [left, setLeft] = useState(x)
  // Its callers key it by the mark it is of, so another mark's card is measured afresh.
  useLayoutEffect(() => {
    const tip = ref.current?.getBoundingClientRect().width ?? 0
    // Beside the mark, never over it: on the side with more room.
    const beside = x > width / 2 ? x - tip - 12 : x + 12
    setLeft(Math.min(Math.max(0, beside), Math.max(0, width - tip)))
  }, [x, width])
  return (
    <div ref={ref} className="ui-chart-tip" style={{ left }} role="presentation">
      <p className="ui-chart-tip-title">{title}</p>
      {lines.map(line => (
        <p key={line.label} className="ui-chart-tip-line">
          {line.series !== undefined ? <i className="ui-chart-swatch" style={{ background: chartColour(line.series) }} /> : <i />}
          <span>{line.label}</span>
          <b>{line.value}</b>
        </p>
      ))}
    </div>
  )
}

/** The series' names beside their colours. */
export function ChartLegend({ series, from = 0, className }: { series: readonly string[]; from?: number; className?: string }) {
  return (
    <ul className={cx('ui-chart-legend', className)}>
      {series.map((name, index) => (
        <li key={name}>
          <i className="ui-chart-swatch" style={{ background: chartColour(from + index) }} />
          {name}
        </li>
      ))}
    </ul>
  )
}

export interface BarColumn {
  key: string
  /** Under the axis, when there is room for it. */
  label: string
  /** The hover card's title; `label` when absent. */
  title?: string
  /** One value a series, bottom first. */
  values: readonly number[]
}

const AXIS = 22
const GUTTER = 40

/**
 * Columns of stacked series over time, one column a bucket. With `onSelect`, a column is a button: choosing one marks
 * it, choosing it again lets it go.
 */
export function BarChart({
  label,
  series,
  columns,
  format,
  height = 160,
  selected,
  onSelect,
  className,
}: {
  label: string
  series: readonly string[]
  columns: readonly BarColumn[]
  format: (value: number) => string
  height?: number
  selected?: string
  onSelect?: (key: string | undefined) => void
  className?: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number>()
  const plot = Math.max(0, width - GUTTER)
  const top = height - AXIS
  const max = niceMax(Math.max(0, ...columns.map(column => column.values.reduce((sum, value) => sum + value, 0))))
  const slot = columns.length > 0 ? plot / columns.length : 0
  const bar = Math.max(1, Math.min(28, Math.floor(slot * 0.64)))
  const gap = bar >= 6 ? 2 : 1
  const shown = labelled(columns.length, Math.max(2, Math.floor(plot / 56)))
  const y = (value: number) => top - (value / max) * (top - 6)
  const active = hover ?? (selected === undefined ? undefined : columns.findIndex(column => column.key === selected))
  const tip = hover === undefined ? undefined : columns[hover]
  return (
    <div ref={ref} className={cx('ui-chart', className)} style={{ height }} onPointerLeave={() => setHover(undefined)}>
      {width > 0 && (
        <svg width={width} height={height} role="group" aria-label={label}>
          {[0, 0.5, 1].map(share => (
            <g key={share} className="ui-chart-grid">
              <line x1={GUTTER} x2={width} y1={Math.round(y(max * share)) + 0.5} y2={Math.round(y(max * share)) + 0.5} />
              <text x={GUTTER - 6} y={y(max * share)} dy="0.32em" textAnchor="end">
                {format(max * share)}
              </text>
            </g>
          ))}
          {columns.map((column, index) => {
            const x = GUTTER + index * slot + (slot - bar) / 2
            const total = column.values.reduce((sum, value) => sum + value, 0)
            let cursor = top
            const marks = column.values.map((value, part) => {
              if (value <= 0) return null
              const end = cursor - (value / max) * (top - 6)
              // A surface gap between parts, taken from the upper one; a part never shrinks below a pixel.
              const bottom = cursor < top ? cursor - gap : cursor
              const h = Math.max(1, bottom - end)
              cursor = end
              return <rect key={part} x={x} y={bottom - h} width={bar} height={h} rx={Math.min(2, bar / 2)} fill={chartColour(part)} />
            })
            const words = `${column.title ?? column.label}：${series.map((name, part) => `${name} ${format(column.values[part] ?? 0)}`).join('，')}`
            return (
              <g
                key={column.key}
                className="ui-chart-column"
                data-active={active === index ? '' : undefined}
                {...(onSelect
                  ? {
                      role: 'button',
                      tabIndex: 0,
                      'aria-pressed': column.key === selected,
                      onClick: () => onSelect(column.key === selected ? undefined : column.key),
                      onKeyDown: (event: React.KeyboardEvent) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        onSelect(column.key === selected ? undefined : column.key)
                      },
                    }
                  : { role: 'img' })}
                aria-label={words}
                onPointerEnter={() => setHover(index)}
                onFocus={() => setHover(index)}
                onBlur={() => setHover(undefined)}>
                <rect className="ui-chart-band" x={GUTTER + index * slot} y={0} width={slot} height={top} />
                {total > 0 ? marks : null}
                {shown.has(index) && (
                  <text className="ui-chart-axis" y={height - 4} {...anchorAt(x + bar / 2, width)}>
                    {column.label}
                  </text>
                )}
              </g>
            )
          })}
          <line className="ui-chart-base" x1={GUTTER} x2={width} y1={top + 0.5} y2={top + 0.5} />
        </svg>
      )}
      {tip && hover !== undefined && (
        <Tip
          key={hover}
          x={GUTTER + hover * slot + slot / 2}
          width={width}
          title={tip.title ?? tip.label}
          lines={[
            ...series.map((name, part) => ({ label: name, value: format(tip.values[part] ?? 0), series: part })).toReversed(),
            { label: '合计', value: format(tip.values.reduce((sum, value) => sum + value, 0)) },
          ]}
        />
      )}
    </div>
  )
}

export interface LinePoint {
  key: string
  label: string
  title?: string
  /** Absent: nothing was measured there, and the line breaks. */
  value?: number
  /** A second line for the hover card. */
  note?: string
}

/**
 * One series over time, on an axis from zero to `max`; a gap where nothing was measured. `active`: a point held as if
 * hovered (the bucket chosen in a chart beside it) while the pointer is elsewhere.
 */
export function LineChart({
  label,
  points,
  format,
  max: given,
  height = 120,
  active,
  className,
}: {
  label: string
  points: readonly LinePoint[]
  format: (value: number) => string
  max?: number
  height?: number
  active?: string
  className?: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [pointer, setHover] = useState<number>()
  const held = active === undefined ? -1 : points.findIndex(point => point.key === active)
  const hover = pointer ?? (held >= 0 ? held : undefined)
  const plot = Math.max(0, width - GUTTER)
  const top = height - AXIS
  const max = given ?? niceMax(Math.max(0, ...points.map(point => point.value ?? 0)))
  const slot = points.length > 0 ? plot / points.length : 0
  const x = (index: number) => GUTTER + index * slot + slot / 2
  const y = (value: number) => top - (value / max) * (top - 6)
  const runs: Array<Array<[number, number]>> = []
  points.forEach((point, index) => {
    if (point.value === undefined) return
    const previous = runs.at(-1)
    const joined = previous && points[index - 1]?.value !== undefined
    const at: [number, number] = [x(index), y(point.value)]
    if (joined) previous.push(at)
    else runs.push([at])
  })
  const shown = labelled(points.length, Math.max(2, Math.floor(plot / 56)))
  const tip = hover === undefined ? undefined : points[hover]
  const pick = (clientX: number, element: Element) => {
    const index = Math.floor((clientX - element.getBoundingClientRect().left - GUTTER) / slot)
    setHover(index >= 0 && index < points.length ? index : undefined)
  }
  const summary = points
    .filter(point => point.value !== undefined)
    .map(point => `${point.title ?? point.label} ${format(point.value!)}`)
    .join('，')
  return (
    <div
      ref={ref}
      className={cx('ui-chart', className)}
      style={{ height }}
      onPointerMove={event => pick(event.clientX, event.currentTarget)}
      onPointerLeave={() => setHover(undefined)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={summary ? `${label}：${summary}` : label}>
          {[0, 0.5, 1].map(share => (
            <g key={share} className="ui-chart-grid">
              <line x1={GUTTER} x2={width} y1={Math.round(y(max * share)) + 0.5} y2={Math.round(y(max * share)) + 0.5} />
              <text x={GUTTER - 6} y={y(max * share)} dy="0.32em" textAnchor="end">
                {format(max * share)}
              </text>
            </g>
          ))}
          {hover !== undefined && <line className="ui-chart-cross" x1={x(hover)} x2={x(hover)} y1={0} y2={top} />}
          {runs.map(run =>
            run.length === 1 ? (
              <circle key={run[0]!.join()} className="ui-chart-dot" cx={run[0]![0]} cy={run[0]![1]} r={3} />
            ) : (
              <polyline key={run[0]!.join()} className="ui-chart-line" points={run.map(point => point.join(',')).join(' ')} />
            ),
          )}
          {tip?.value !== undefined && hover !== undefined && (
            <circle className="ui-chart-dot" data-ring="" cx={x(hover)} cy={y(tip.value)} r={4} />
          )}
          {points.map((point, index) =>
            shown.has(index) ? (
              <text key={point.key} className="ui-chart-axis" y={height - 4} {...anchorAt(x(index), width)}>
                {point.label}
              </text>
            ) : null,
          )}
          <line className="ui-chart-base" x1={GUTTER} x2={width} y1={top + 0.5} y2={top + 0.5} />
        </svg>
      )}
      {tip && hover !== undefined && (
        <Tip
          key={hover}
          x={x(hover)}
          width={width}
          title={tip.title ?? tip.label}
          lines={[
            { label: label, value: tip.value === undefined ? '—' : format(tip.value), series: 0 },
            ...(tip.note ? [{ label: tip.note, value: '' }] : []),
          ]}
        />
      )}
    </div>
  )
}

const WEEK = ['一', '二', '三', '四', '五', '六', '日'] as const

/**
 * Hours of the week, Monday first, as a 7 × 24 grid of cells: one hue, deeper for more, the track grey for none.
 * `values` holds 168 counts, Monday 00:00 first.
 */
export function HeatGrid({
  label,
  values,
  format,
  className,
}: {
  label: string
  values: readonly number[]
  format: (value: number) => string
  className?: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number>()
  const gutter = 20
  const pitch = Math.max(4, Math.floor((width - gutter) / 24))
  const cell = pitch - 2
  const rowPitch = Math.min(Math.max(8, cell), 16) + 2
  const height = rowPitch * 7 + AXIS - 2
  const max = Math.max(0, ...values)
  const level = (value: number) => (value <= 0 || max <= 0 ? 0 : Math.max(1, Math.ceil((value / max) * 4)))
  const total = values.reduce((sum, value) => sum + value, 0)
  return (
    <div ref={ref} className={cx('ui-chart', className)} style={{ height }} onPointerLeave={() => setHover(undefined)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${label}：共 ${format(total)}`}>
          {WEEK.map((day, row) =>
            row % 2 === 1 ? null : (
              <text key={day} className="ui-chart-axis" x={0} y={row * rowPitch + (rowPitch - 2) / 2} dy="0.32em">
                {day}
              </text>
            ),
          )}
          {values.slice(0, 168).map((value, index) => (
            <rect
              key={index}
              className="ui-chart-cell"
              data-level={level(value)}
              data-active={hover === index ? '' : undefined}
              x={gutter + (index % 24) * pitch}
              y={Math.floor(index / 24) * rowPitch}
              width={cell}
              height={rowPitch - 2}
              rx={2}
              onPointerEnter={() => setHover(index)}
            />
          ))}
          {[0, 6, 12, 18].map(hour => (
            <text key={hour} className="ui-chart-axis" x={gutter + hour * pitch} y={height - 4}>
              {hour}
            </text>
          ))}
        </svg>
      )}
      {hover !== undefined && (
        <Tip
          key={hover}
          x={gutter + (hover % 24) * pitch + cell / 2}
          width={width}
          title={`周${WEEK[Math.floor(hover / 24)]} ${hover % 24}:00–${(hover % 24) + 1}:00`}
          lines={[{ label, value: format(values[hover] ?? 0), series: 0 }]}
        />
      )}
    </div>
  )
}

export interface SharePart {
  key: string
  label: ReactNode
  /** The words for the label in the hover card and to a screen reader. */
  name: string
  value: number
  /** Series colour; absent: the parts take them in order. `rest`: the quiet ink of everything else. */
  series?: number | 'rest'
}

/** Parts of a whole: one bar cut in proportion, then each part with its share and figure. */
export function ShareBar({
  label,
  parts,
  format,
  className,
}: {
  label: string
  parts: readonly SharePart[]
  format: (value: number) => string
  className?: string
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0)
  const live = parts.filter(part => part.value > 0)
  const room = Math.max(0, width - 2 * Math.max(0, live.length - 1))
  const colour = (part: SharePart, index: number) => (part.series === 'rest' ? 'var(--faint)' : chartColour(part.series ?? index))
  const percent = (value: number) => (total > 0 ? `${value / total < 0.01 && value > 0 ? '<1' : Math.round((value / total) * 100)}%` : '—')
  const lengths = live.map(part => Math.max(2, (part.value / total) * room))
  const starts = laid(lengths)
  return (
    <div className={cx('ui-share', className)}>
      <div ref={ref} className="ui-share-bar">
        {width > 0 && (
          <svg
            width={width}
            height={8}
            role="img"
            aria-label={`${label}：${parts.map(part => `${part.name} ${percent(part.value)}`).join('，')}`}>
            {total > 0 ? (
              live.map((part, index) => (
                <rect
                  key={part.key}
                  x={starts[index]}
                  y={0}
                  width={lengths[index]}
                  height={8}
                  rx={2}
                  fill={colour(part, parts.indexOf(part))}
                />
              ))
            ) : (
              <rect className="ui-share-empty" x={0} y={0} width={width} height={8} rx={2} />
            )}
          </svg>
        )}
      </div>
      <ul className="ui-share-parts">
        {parts.map((part, index) => (
          <li key={part.key} title={`${part.name} ${format(part.value)}`}>
            <i className="ui-chart-swatch" style={{ background: colour(part, index) }} />
            <span className="ui-share-name">{part.label}</span>
            <span className="ui-share-value">{format(part.value)}</span>
            <span className="ui-share-percent">{percent(part.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export interface BarRow {
  key: string
  label: ReactNode
  name: string
  values: readonly number[]
  /** After the bar, in figures. */
  figure: string
}

/**
 * Rows of stacked bars on one shared scale, so rows compare by length: one row a thing, one colour a series. `from`: the
 * first series' colour, so the same series keeps its colour from chart to chart.
 */
export function BarRows({
  label,
  series,
  rows,
  format,
  from = 0,
  className,
}: {
  label: string
  series: readonly string[]
  rows: readonly BarRow[]
  format: (value: number) => string
  from?: number
  className?: string
}) {
  const max = Math.max(0, ...rows.map(row => row.values.reduce((sum, value) => sum + value, 0)))
  return (
    <ul className={cx('ui-bar-rows', className)} aria-label={label}>
      {rows.map(row => (
        <li key={row.key} title={series.map((name, index) => `${name} ${format(row.values[index] ?? 0)}`).join('\n')}>
          <span className="ui-bar-rows-name">{row.label}</span>
          <BarTrack
            values={row.values}
            max={max}
            from={from}
            name={`${row.name}：${series.map((name, index) => `${name} ${format(row.values[index] ?? 0)}`).join('，')}`}
          />
          <span className="ui-bar-rows-figure">{row.figure}</span>
        </li>
      ))}
    </ul>
  )
}

function BarTrack({ values, max, from, name }: { values: readonly number[]; max: number; from: number; name: string }) {
  const [ref, width] = useWidth<HTMLSpanElement>()
  const shown = values.flatMap((value, index) => (value > 0 && max > 0 ? [{ index, value }] : []))
  // The gaps come out of the bar, so a row's length stays its total's share of the longest.
  const lengths = shown.map(part => Math.max(2, (part.value / max) * width - (shown.length > 1 ? 2 : 0)))
  const starts = laid(lengths)
  return (
    <span ref={ref} className="ui-bar-rows-track">
      {width > 0 && (
        <svg width={width} height={8} role="img" aria-label={name}>
          {shown.map((part, position) => (
            <rect
              key={part.index}
              x={starts[position]}
              y={0}
              width={lengths[position]}
              height={8}
              rx={2}
              fill={chartColour(from + part.index)}
            />
          ))}
        </svg>
      )}
    </span>
  )
}

/**
 * A thing's parts as one short cut bar, for a row of a table: where its total came from. The figures are its name to a
 * screen reader and its hover; the table's own column says the total.
 */
export function SourceSplit({
  parts,
  format,
  className,
}: {
  parts: ReadonlyArray<{ name: string; value: number; series: number }>
  format: (value: number) => string
  className?: string
}) {
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.value), 0)
  const live = parts.filter(part => part.value > 0)
  const width = 64
  const room = width - 2 * Math.max(0, live.length - 1)
  const lengths = live.map(part => Math.max(2, (part.value / total) * room))
  const starts = laid(lengths)
  const words = parts.map(part => `${part.name} ${format(part.value)}`).join('，')
  return (
    <span className={cx('ui-source-split', className)} title={words.replaceAll('，', '\n')}>
      <svg width={width} height={4} role="img" aria-label={words}>
        {total > 0 ? (
          live.map((part, index) => (
            <rect key={part.name} x={starts[index]} y={0} width={lengths[index]} height={4} rx={1} fill={chartColour(part.series)} />
          ))
        ) : (
          <rect className="ui-share-empty" x={0} y={0} width={width} height={4} rx={1} />
        )}
      </svg>
    </span>
  )
}
