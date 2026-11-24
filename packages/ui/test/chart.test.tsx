import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { BarChart, BarRows, HeatGrid, LineChart, ShareBar, SourceSplit, labelled, niceMax } from '../src/chart.tsx'
import { emulateMedia } from './helpers.ts'

const format = (value: number) => String(Math.round(value))
const columns = [
  { key: 'a', label: '11/14', values: [10, 20, 5] },
  { key: 'b', label: '11/15', values: [0, 0, 0] },
  { key: 'c', label: '11/16', values: [40, 30, 30] },
]

const box = (element: Element) => element.getBoundingClientRect()

describe('charts', () => {
  it('rounds an axis up to 1, 2, 2.5 or 5 of a power of ten, and labels the first, the last and evenly between', () => {
    expect([niceMax(0), niceMax(7), niceMax(12), niceMax(240), niceMax(4100)]).toEqual([1, 10, 20, 250, 5000])
    expect([...labelled(5, 10)]).toEqual([0, 1, 2, 3, 4])
    const shown = labelled(30, 6)
    expect(shown.has(0) && shown.has(29)).toBe(true)
    expect(shown.size).toBeLessThanOrEqual(7)
  })

  it('stacks each column’s series in order on one scale, a surface gap between parts, nothing for an empty column', async () => {
    const screen = await render(
      <div style={{ width: 400 }}>
        <BarChart label="每日 tokens" series={['缓存读取', '输入', '输出']} columns={columns} format={format} />
      </div>,
    )
    await vi.waitFor(() => expect(screen.container.querySelectorAll('.ui-chart-column')).toHaveLength(3))
    const groups = Array.from(screen.container.querySelectorAll('.ui-chart-column'))
    const parts = (index: number) => Array.from(groups[index].querySelectorAll('rect:not(.ui-chart-band)'))
    expect(parts(0).map(rect => rect.getAttribute('fill'))).toEqual(['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'])
    expect(parts(1)).toHaveLength(0)
    // The tallest column is the tallest; the parts are laid bottom up with a gap of two between them.
    const heights = [0, 2].map(index => parts(index).reduce((sum, rect) => sum + box(rect).height, 0))
    expect(heights[1]).toBeGreaterThan(heights[0])
    const [bottom, middle] = parts(2).map(box)
    expect(Math.round(bottom!.top - middle!.bottom)).toBe(2)
    expect(groups[2]!.getAttribute('aria-label')).toBe('11/16：缓存读取 40，输入 30，输出 30')
  })

  it('tells a column’s figures on hover, and makes it a button that marks it when it can be chosen', async () => {
    const chosen: Array<string | undefined> = []
    const screen = await render(
      <div style={{ width: 400 }}>
        <BarChart
          label="每日"
          series={['缓存读取', '输入', '输出']}
          columns={columns}
          format={format}
          onSelect={key => chosen.push(key)}
          selected="c"
        />
      </div>,
    )
    const column = screen.getByRole('button', { name: /^11\/16/u })
    await column.hover()
    await expect.element(screen.getByText('合计')).toBeVisible()
    expect(screen.container.querySelector('.ui-chart-tip')!.textContent).toContain('100')
    await expect.element(column).toHaveAttribute('aria-pressed', 'true')
    expect(screen.container.querySelectorAll('.ui-chart-column[aria-pressed="true"]')).toHaveLength(1)
    await column.click()
    await screen.getByRole('button', { name: /^11\/14/u }).click()
    expect(chosen).toEqual([undefined, 'a'])
  })

  it('breaks a line where nothing was measured, and keeps its height before and after it has measured', async () => {
    const screen = await render(
      <div style={{ width: 300 }}>
        <LineChart
          label="缓存命中"
          max={1}
          format={value => `${Math.round(value * 100)}%`}
          points={[
            { key: '1', label: '1', value: 0.5 },
            { key: '2', label: '2', value: 0.7 },
            { key: '3', label: '3' },
            { key: '4', label: '4', value: 0.2 },
          ]}
        />
      </div>,
    )
    await vi.waitFor(() => expect(screen.container.querySelector('svg')).not.toBeNull())
    expect(screen.container.querySelectorAll('.ui-chart-line')).toHaveLength(1)
    expect(screen.container.querySelectorAll('.ui-chart-dot')).toHaveLength(1)
    expect(box(screen.container.querySelector('.ui-chart')!).height).toBe(120)
  })

  it('shades the hours of the week in one hue by four depths, the track grey for none, Monday first', async () => {
    const values = Array.from({ length: 168 }, (_, index) => (index === 0 ? 8 : index === 30 ? 2 : 0))
    const screen = await render(
      <div style={{ width: 360 }}>
        <HeatGrid label="时段" values={values} format={value => `${value} 次`} />
      </div>,
    )
    await vi.waitFor(() => expect(screen.container.querySelectorAll('.ui-chart-cell')).toHaveLength(168))
    const cells = Array.from(screen.container.querySelectorAll('.ui-chart-cell'))
    expect([cells[0], cells[30], cells[1]].map(cell => cell!.getAttribute('data-level'))).toEqual(['4', '1', '0'])
    expect(getComputedStyle(cells[1]!).fill).toBe('rgba(18, 18, 28, 0.11)')
    await emulateMedia({ 'prefers-color-scheme': 'dark' }, () => {
      expect(getComputedStyle(cells[0]!).fill).toBe('rgb(33, 162, 132)')
    })
  })

  it('cuts a share in proportion and writes each part with its figure and share', async () => {
    const screen = await render(
      <div style={{ width: 300 }}>
        <ShareBar
          label="来源"
          format={format}
          parts={[
            { key: 'a', name: '经 Latch 服务', label: '经 Latch 服务', value: 75 },
            { key: 'b', name: '自己登录', label: '自己登录', value: 25 },
            { key: 'c', name: '其他', label: '其他', value: 0, series: 'rest' },
          ]}
        />
        <BarRows
          label="每轮"
          series={['输入', '输出']}
          from={1}
          format={format}
          rows={[
            { key: 'x', name: 'Codex', label: 'Codex', values: [30, 10], figure: '40 / 轮' },
            { key: 'y', name: 'OpenCode', label: 'OpenCode', values: [10, 10], figure: '20 / 轮' },
          ]}
        />
      </div>,
    )
    await vi.waitFor(() => expect(screen.container.querySelectorAll('.ui-share-bar rect')).toHaveLength(2))
    const [gateway, own] = Array.from(screen.container.querySelectorAll('.ui-share-bar rect')).map(box)
    expect(Math.round(gateway!.width / own!.width)).toBe(3)
    expect(Array.from(screen.container.querySelectorAll('.ui-share-percent')).map(item => item.textContent)).toEqual(['75%', '25%', '0%'])
    await vi.waitFor(() => expect(screen.container.querySelectorAll('.ui-bar-rows rect')).toHaveLength(4))
    const rows = Array.from(screen.container.querySelectorAll('.ui-bar-rows-track svg')).map(svg =>
      Array.from(svg.querySelectorAll('rect')).reduce((sum, rect) => sum + box(rect).width, 0),
    )
    expect(rows[0]! / rows[1]!).toBeGreaterThan(1.8)
    expect(screen.container.querySelector('.ui-bar-rows rect')!.getAttribute('fill')).toBe('var(--chart-2)')
  })

  it('splits a row’s total by its sources on one short bar, named with the figures', async () => {
    const screen = await render(
      <SourceSplit
        format={format}
        parts={[
          { name: '经 Latch 服务', value: 30, series: 0 },
          { name: '自己登录', value: 10, series: 1 },
        ]}
      />,
    )
    const bar = screen.getByRole('img', { name: '经 Latch 服务 30，自己登录 10' }).element()
    const [first, second] = Array.from(bar.querySelectorAll('rect')).map(rect => Number(rect.getAttribute('width')))
    expect(Math.round(first! / second!)).toBe(3)
    expect(Array.from(bar.querySelectorAll('rect')).map(rect => rect.getAttribute('fill'))).toEqual(['var(--chart-1)', 'var(--chart-2)'])
  })
})
