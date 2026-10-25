import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import {
  Button,
  Count,
  DemoMark,
  DevMark,
  DialogSurface,
  EmptyState,
  ErrorState,
  IconButton,
  InlineNotice,
  Loading,
  SheetSurface,
  Skeleton,
  StatusDot,
  StatusPill,
  Tile,
  Toast,
} from '../src/index.ts'
import { ShieldCheck } from 'lucide-react'
import { press, protocol } from './helpers.ts'

const color = (element: Element | null) => (element ? getComputedStyle(element).color : '')

/** Brand marks as files: a one-colour shape, and one that brings its own colours. */
const MONO_MARK = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>')}`
const COLOUR_MARK = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#e8960f"/></svg>')}`

/** The relative luminance of an opaque `rgb(r, g, b)` colour. */
function luminance(value: string): number {
  const [red = 0, green = 0, blue = 0] = (value.match(/\d+(?:\.\d+)?/gu) ?? []).map(part => {
    const channel = Number(part) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

/** WCAG contrast between two opaque colours. */
function contrast(first: string, second: string): number {
  const [a, b] = [luminance(first), luminance(second)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

describe('notices and toasts', () => {
  it('announces an error notice as an alert and the others as status, with the tone only on the glyph and title', async () => {
    const closed = vi.fn()
    const screen = await render(
      <div>
        <InlineNotice tone="error" title="审计记录被回滚" onClose={closed}>
          上次看到的记录不在了。
        </InlineNotice>
        <InlineNotice tone="warn" title="连接已中断">
          已显示的内容都在。
        </InlineNotice>
      </div>,
    )
    const alert = screen.getByRole('alert')
    await expect.element(alert).toBeVisible()
    expect(alert.element().querySelector('.ui-notice-text')?.textContent).toBe('审计记录被回滚上次看到的记录不在了。')
    expect(color(alert.element().querySelector('.ui-notice-title'))).toBe('rgb(160, 29, 20)')
    expect(color(alert.element().querySelector('.ui-notice-text'))).toBe('rgb(68, 68, 66)')
    expect(screen.getByRole('status').element().textContent).toBe('连接已中断已显示的内容都在。')
    press(screen.getByRole('button', { name: '关闭' }))
    expect(closed).toHaveBeenCalledOnce()
  })

  it('takes a toast away after its time', async () => {
    const dismissed = vi.fn()
    const screen = await render(
      <Toast duration={50} onDismiss={dismissed}>
        已由「我的手机」处理
      </Toast>,
    )
    await expect.element(screen.getByRole('status')).toHaveTextContent('已由「我的手机」处理')
    await expect.poll(() => dismissed.mock.calls.length).toBe(1)
  })
})

describe('pills, counts and marks', () => {
  it('keeps pills round and never blue, and caps counts at 99+', async () => {
    const screen = await render(
      <div>
        <StatusPill tone="warn">等你批准</StatusPill>
        <Count value={128} tone="warn" />
        <DemoMark />
      </div>,
    )
    const pill = screen.getByText('等你批准').element()
    expect(getComputedStyle(pill).borderTopLeftRadius).toBe('999px')
    expect(getComputedStyle(pill).height).toBe('20px')
    expect(color(pill)).toBe('rgb(154, 83, 0)')
    await expect.element(screen.getByText('99+')).toBeVisible()
    expect(getComputedStyle(screen.getByText('演示模型').element()).height).toBe('16px')
  })

  it('names the development mark with its whole sentence and keeps it neutral', async () => {
    const screen = await render(<DevMark description="开发模式：Host 代码可被本机修改" />)
    const mark = screen.getByRole('note', { name: '开发模式：Host 代码可被本机修改' })
    await expect.element(mark).toHaveTextContent('开发版')
    expect(color(mark.element())).toBe('rgb(68, 68, 66)')
  })

  it('hides a status dot from screen readers unless it is labelled', async () => {
    const screen = await render(
      <div>
        <StatusDot tone="warn" />
        <StatusDot tone="unread" label="未读" />
      </div>,
    )
    await expect.element(screen.getByRole('img', { name: '未读' })).toBeVisible()
    expect(screen.container.querySelectorAll('[aria-hidden="true"].ui-status-dot')).toHaveLength(1)
  })
})

describe('empty, loading and error states', () => {
  it('writes an empty state as a short line with one action and announces loading politely', async () => {
    const screen = await render(
      <div>
        <EmptyState title="还没有会话" description="新建会话后，会话会保存在这里。" action={<Button size="xs">新建会话</Button>} />
        <Loading label="正在连接执行端…" variant="page" />
        <Skeleton width={120} />
      </div>,
    )
    await expect.element(screen.getByText('还没有会话')).toBeVisible()
    await expect.element(screen.getByRole('status')).toHaveTextContent('正在连接执行端…')
    expect(screen.container.querySelector('.ui-skeleton')?.getAttribute('aria-hidden')).toBe('true')
  })

  it('puts a red triangle, the title and at most two buttons on the error card', async () => {
    const screen = await render(
      <ErrorState
        title="界面出错，当前内容无法显示。"
        description="会话和草稿都在执行端，重新加载不会丢失。"
        actions={
          <>
            <Button>回到新会话</Button>
            <Button variant="primary">重新加载</Button>
          </>
        }
      />,
    )
    const card = screen.getByRole('alert')
    await expect.element(screen.getByRole('heading', { name: '界面出错，当前内容无法显示。' })).toBeVisible()
    expect(color(card.element().querySelector('.lucide-triangle-alert'))).toBe('rgb(160, 29, 20)')
    expect(card.element().querySelectorAll('button')).toHaveLength(2)
  })
})

describe('tiles', () => {
  it('rounds every tile by size × 0.225 and never draws a letter', async () => {
    const screen = await render(
      <div>
        {([16, 20, 24, 32, 40, 56] as const).map(size => (
          <Tile key={size} size={size} mark={{ src: MONO_MARK, mono: true }} />
        ))}
        <Tile size={32} icon={ShieldCheck} />
      </div>,
    )
    const faces = Array.from(screen.container.querySelectorAll('.ui-tile-face'), face => getComputedStyle(face).borderTopLeftRadius)
    expect(faces).toEqual(['4px', '5px', '5px', '7px', '9px', '13px', '7px'])
    expect(screen.container.textContent).toBe('')
  })

  it('draws glyphs and one-colour marks in text-1 on the shared plate, and a plain glyph in the ink of the paper', async () => {
    const screen = await render(
      <div className="paper" style={{ background: 'var(--bg-pane)' }}>
        <Tile size={16} plain icon={ShieldCheck} />
        <Tile size={32} icon={ShieldCheck} />
        <Tile size={32} mark={{ src: MONO_MARK, mono: true }} />
        <Tile size={32} mark={{ src: COLOUR_MARK }} />
      </div>,
    )
    const paper = () => getComputedStyle(screen.container.querySelector('.paper')!).backgroundColor
    // A one-colour mark is the file as a mask, filled with text-1; a coloured one is the file itself. Neither is markup.
    const mask = screen.container.querySelector<HTMLElement>('.ui-tile-mark')!
    expect(getComputedStyle(mask).maskImage).toBe(`url("${MONO_MARK}")`)
    const image = screen.container.querySelector('.ui-tile img')!
    expect([image.getAttribute('src'), image.getAttribute('alt')]).toEqual([COLOUR_MARK, ''])
    expect(screen.container.querySelectorAll('.ui-tile-face svg')).toHaveLength(2)
    const faces = () => {
      const [bare, plated] = Array.from(screen.container.querySelectorAll('.ui-tile-face'), face => getComputedStyle(face))
      if (!bare || !plated) throw new Error('Expected a plain and a plated tile')
      return { bare, plated, ink: getComputedStyle(document.documentElement).color }
    }
    const check = (plate: string, text1: string) => {
      const { bare, plated, ink } = faces()
      expect([plated.backgroundColor, plated.color, getComputedStyle(mask).backgroundColor, ink]).toEqual([plate, text1, text1, text1])
      expect(contrast(plated.color, plated.backgroundColor)).toBeGreaterThanOrEqual(4.5)
      // The plain glyph has no plate under it and reads on the paper.
      expect(bare.backgroundColor).toBe('rgba(0, 0, 0, 0)')
      expect(contrast(bare.color, paper())).toBeGreaterThanOrEqual(4.5)
    }
    check('rgb(255, 255, 255)', 'rgb(29, 28, 26)')
    await protocol().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    try {
      // The dark plate is a neutral grey a step lighter than the paper, so the mark turns soft white with the text.
      check('rgb(46, 46, 45)', 'rgb(234, 233, 231)')
    } finally {
      await protocol().send('Emulation.setEmulatedMedia', { features: [] })
    }
  })

  it('draws a glyph with the same line weight at every tile size, 1.25px when small and 1.5px from 20', async () => {
    const screen = await render(
      <div>
        {([16, 20, 24, 32, 40, 56] as const).map(size => (
          <Tile key={size} size={size} icon={ShieldCheck} />
        ))}
        <Tile size={16} plain icon={ShieldCheck} />
      </div>,
    )
    // The line as drawn: the stroke in the 24-unit viewBox scaled to the glyph's rendered width.
    const lines = Array.from(screen.container.querySelectorAll<SVGSVGElement>('.ui-tile-face svg'), glyph => {
      const width = glyph.getBoundingClientRect().width
      return Math.round(((Number(glyph.getAttribute('stroke-width')) * width) / 24) * 100) / 100
    })
    expect(lines).toEqual([1.25, 1.25, 1.25, 1.5, 1.5, 1.5, 1.25])
  })

  it("shows the brand's own dark file in the dark theme, by preference or by choice", async () => {
    await protocol().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    const screen = await render(<Tile size={32} mark={{ src: COLOUR_MARK, dark: MONO_MARK }} />)
    const shown = () =>
      Array.from(screen.container.querySelectorAll<HTMLImageElement>('.ui-tile img'))
        .filter(image => getComputedStyle(image).display !== 'none')
        .map(image => image.getAttribute('src'))
    expect(shown()).toEqual([COLOUR_MARK])
    await protocol().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    try {
      expect(shown()).toEqual([MONO_MARK])
      // A page that chose light keeps the light file under a dark system preference.
      document.documentElement.dataset.theme = 'light'
      expect(shown()).toEqual([COLOUR_MARK])
    } finally {
      delete document.documentElement.dataset.theme
      await protocol().send('Emulation.setEmulatedMedia', { features: [] })
    }
    document.documentElement.dataset.theme = 'dark'
    try {
      expect(shown()).toEqual([MONO_MARK])
    } finally {
      delete document.documentElement.dataset.theme
    }
  })

  it('shows an app icon whole, without the plate, the ring or our corners, and lets a file with its own margin span the plate', async () => {
    await protocol().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
    const screen = await render(
      <div>
        <Tile size={32} mark={{ src: COLOUR_MARK, tile: true }} />
        <Tile size={32} mark={{ src: COLOUR_MARK, margin: true }} />
        <Tile size={32} mark={{ src: COLOUR_MARK }} />
      </div>,
    )
    const [app, margin, plain] = Array.from(screen.container.querySelectorAll('.ui-tile-face'), face => getComputedStyle(face))
    expect([app?.backgroundColor, app?.boxShadow, app?.borderTopLeftRadius, app?.overflow]).toEqual([
      'rgba(0, 0, 0, 0)',
      'none',
      '0px',
      'visible',
    ])
    expect(margin?.backgroundColor).toBe('rgb(255, 255, 255)')
    const widths = Array.from(screen.container.querySelectorAll('.ui-tile img'), image => image.getBoundingClientRect().width)
    expect(widths).toEqual([32, 32, 20])
    expect(plain?.overflow).toBe('hidden')
  })

  it('draws readiness on the tile: grey when cold, a progress ring while arriving, a red dot when failed', async () => {
    const screen = await render(
      <div>
        <Tile mark={{ src: MONO_MARK, mono: true }} state="cold" />
        <Tile mark={{ src: MONO_MARK, mono: true }} state="arriving" progress={0.6} />
        <Tile mark={{ src: MONO_MARK, mono: true }} state="failed" label="goose：上次运行异常" />
      </div>,
    )
    const [cold, arriving] = Array.from(screen.container.querySelectorAll('.ui-tile-face'), face => getComputedStyle(face).filter)
    expect(cold).toBe('grayscale(1) opacity(0.4)')
    expect(arriving).toBe('grayscale(1) opacity(0.7)')
    expect(screen.container.querySelector('.ui-tile-progress-arc')?.getAttribute('stroke-dasharray')).toBe('60 100')
    await expect.element(screen.getByRole('img', { name: 'goose：上次运行异常' })).toBeVisible()
    expect(getComputedStyle(screen.container.querySelector('.ui-tile-dot')!).backgroundColor).toBe('rgb(217, 45, 32)')
  })

  it('keeps a 2px gap between an arriving tile and its 2px progress ring', async () => {
    const screen = await render(<Tile mark={{ src: MONO_MARK, mono: true }} size={32} state="arriving" progress={0.6} />)
    const tile = screen.container.querySelector('.ui-tile')!.getBoundingClientRect()
    const track = screen.container.querySelector('.ui-tile-progress-track')!
    // The stroke is centred on the ring's path, 3px out: its inner edge is 2px from the tile.
    const path = track.getBoundingClientRect()
    expect([tile.left - path.left, tile.top - path.top, path.right - tile.right, path.bottom - tile.bottom]).toEqual([3, 3, 3, 3])
    expect(getComputedStyle(track).strokeWidth).toBe('2px')
    expect(track.getAttribute('rx')).toBe('10')
  })

  it("starts the progress arc at 12 o'clock and keeps an indeterminate ring turning when motion is reduced", async () => {
    const screen = await render(
      <div>
        <Tile mark={{ src: MONO_MARK, mono: true }} size={32} state="arriving" progress={0.25} />
        <Tile mark={{ src: MONO_MARK, mono: true }} size={32} state="arriving" />
      </div>,
    )
    const [determinate, indeterminate] = Array.from(screen.container.querySelectorAll<SVGPathElement>('.ui-tile-progress-arc'))
    // The 40px ring box: the arc's path starts at its top centre and a quarter of it ends on the right edge's middle.
    const start = determinate?.getPointAtLength(0)
    expect([start?.x, start?.y]).toEqual([20, 1])
    const quarter = determinate?.getPointAtLength((determinate.getTotalLength() * 25) / 100)
    expect([Math.round(quarter?.x ?? 0), Math.round(quarter?.y ?? 0)]).toEqual([39, 20])
    expect(determinate?.getAttribute('stroke-dasharray')).toBe('25 100')
    await protocol().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    try {
      const turning = getComputedStyle(indeterminate)
      expect([turning.animationName, turning.animationDuration, turning.animationIterationCount]).toEqual([
        'ui-tile-progress',
        '1.4s',
        'infinite',
      ])
      expect(getComputedStyle(determinate).animationName).toBe('none')
    } finally {
      await protocol().send('Emulation.setEmulatedMedia', { features: [] })
    }
  })

  it('cuts a dot or a count out in the colour of the layer it sits on, in both themes', async () => {
    const screen = await render(
      <div>
        <div className="ui-popover">
          <Tile mark={{ src: MONO_MARK, mono: true }} size={24} state="failed" />
          <IconButton label="2 项待批准" icon={ShieldCheck} badge={<Count value={2} tone="warn" />} />
        </div>
        <DialogSurface title="Agent">
          <Tile mark={{ src: MONO_MARK, mono: true }} size={24} state="failed" />
        </DialogSurface>
        <SheetSurface title="Agent">
          <Tile mark={{ src: MONO_MARK, mono: true }} size={24} state="failed" />
        </SheetSurface>
      </div>,
    )
    const cutOuts = () =>
      Array.from(screen.container.querySelectorAll('.ui-tile-dot, .ui-icon-button-badge'), dot => {
        const layer = dot.closest('.ui-popover, .ui-dialog-surface, .ui-sheet-surface')!
        return getComputedStyle(dot).boxShadow.startsWith(getComputedStyle(layer).backgroundColor)
      })
    expect(cutOuts()).toEqual([true, true, true, true])
    await protocol().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    try {
      expect(cutOuts()).toEqual([true, true, true, true])
      // In the dark theme a raised layer (#252423) is lighter than the paper (#1c1c1b): the ring is not the paper's.
      const dot = screen.container.querySelector('.ui-popover .ui-tile-dot')!
      expect(getComputedStyle(dot).boxShadow).toMatch(/^rgb\(37, 36, 35\) /u)
    } finally {
      await protocol().send('Emulation.setEmulatedMedia', { features: [] })
    }
  })
})
