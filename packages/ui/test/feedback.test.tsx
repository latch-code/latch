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
import { emulateMedia, press } from './helpers.ts'

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
    expect(color(alert.element().querySelector('.ui-notice-title'))).toBe('rgb(180, 35, 31)')
    expect(color(alert.element().querySelector('.ui-notice-text'))).toBe('rgb(52, 52, 59)')
    // The raised surface under a red tint and edge; the warning's glyph in the amber of icons.
    expect(getComputedStyle(alert.element()).backgroundImage).toMatch(/^linear-gradient/u)
    expect(getComputedStyle(alert.element()).borderTopColor).toBe('rgba(213, 67, 61, 0.22)')
    expect(color(screen.getByRole('status').element().querySelector('.ui-notice-glyph'))).toBe('rgb(196, 111, 6)')
    // A warning keeps the neutral surface; only its glyph and title are amber.
    expect(getComputedStyle(screen.getByRole('status').element()).backgroundImage).toBe('none')
    expect(getComputedStyle(screen.getByRole('status').element()).backgroundColor).toBe('rgb(255, 255, 255)')
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

describe('badges, counts and marks', () => {
  it('draws a state as words without a pill, a badge as an 18px tag with 4px corners, and caps counts at 99+', async () => {
    const screen = await render(
      <div>
        <StatusPill tone="warn">原内容未知</StatusPill>
        <Count value={128} tone="warn" />
        <DemoMark />
      </div>,
    )
    const state = screen.getByText('原内容未知').element()
    expect([getComputedStyle(state).backgroundColor, color(state)]).toEqual(['rgba(0, 0, 0, 0)', 'rgb(136, 74, 6)'])
    await expect.element(screen.getByText('99+')).toBeVisible()
    const badge = getComputedStyle(screen.getByText('演示模型').element())
    expect([badge.height, badge.borderTopLeftRadius, badge.backgroundColor, badge.color]).toEqual([
      '18px',
      '4px',
      'rgba(18, 18, 28, 0.067)',
      'rgb(136, 74, 6)',
    ])
  })

  it('names the development mark with its whole sentence and keeps it neutral', async () => {
    const screen = await render(<DevMark description="开发模式：Host 代码可被本机修改" />)
    const mark = screen.getByRole('note', { name: '开发模式：Host 代码可被本机修改' })
    await expect.element(mark).toHaveTextContent('开发版')
    expect([color(mark.element()), getComputedStyle(mark.element()).backgroundColor]).toEqual([
      'rgb(86, 86, 95)',
      'rgba(18, 18, 28, 0.067)',
    ])
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
    expect(color(card.element().querySelector('.latch-glyph-warning'))).toBe('rgb(180, 35, 31)')
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

  it('draws a mark on the raised surface, a glyph in ink on the hover fill, both under a hairline ring, and a plain glyph in ink-2', async () => {
    const screen = await render(
      <div className="canvas" style={{ background: 'var(--canvas)' }}>
        <Tile size={16} plain icon={ShieldCheck} />
        <Tile size={32} icon={ShieldCheck} />
        <Tile size={32} mark={{ src: MONO_MARK, mono: true }} />
        <Tile size={32} mark={{ src: COLOUR_MARK }} />
      </div>,
    )
    // A one-colour mark is the file as a mask, filled with ink; a coloured one is the file itself. Neither is markup.
    const mask = screen.container.querySelector<HTMLElement>('.ui-tile-mark')!
    expect(getComputedStyle(mask).maskImage).toBe(`url("${MONO_MARK}")`)
    const image = screen.container.querySelector('.ui-tile img')!
    expect([image.getAttribute('src'), image.getAttribute('alt')]).toEqual([COLOUR_MARK, ''])
    expect(screen.container.querySelectorAll('.ui-tile-face svg')).toHaveLength(2)
    const check = (raised: string, hover: string, ink: string, ink2: string, line: string) => {
      const [bare, glyph, mono] = Array.from(screen.container.querySelectorAll('.ui-tile-face'), face => getComputedStyle(face))
      expect([glyph?.backgroundColor, glyph?.color, mono?.backgroundColor, getComputedStyle(mask).backgroundColor]).toEqual([
        hover,
        ink,
        raised,
        ink,
      ])
      expect([bare?.backgroundColor, bare?.color]).toEqual(['rgba(0, 0, 0, 0)', ink2])
      // The ring lies over the artwork, not under it.
      const ring = getComputedStyle(screen.container.querySelectorAll('.ui-tile-face')[2]!, '::after')
      expect(ring.boxShadow).toBe(`${line} 0px 0px 0px 1px inset`)
      expect(contrast(ink, getComputedStyle(screen.container.querySelector('.canvas')!).backgroundColor)).toBeGreaterThanOrEqual(4.5)
    }
    check('rgb(255, 255, 255)', 'rgba(18, 18, 28, 0.05)', 'rgb(23, 23, 26)', 'rgb(52, 52, 59)', 'rgba(18, 18, 28, 0.075)')
    await emulateMedia({ 'prefers-color-scheme': 'dark' }, () => {
      check('rgb(27, 27, 31)', 'rgba(255, 255, 255, 0.05)', 'rgb(236, 236, 239)', 'rgb(201, 201, 208)', 'rgba(255, 255, 255, 0.06)')
    })
  })

  it('draws a glyph with the same line weight at every tile size, 1.2px when small and 1.5px from 20', async () => {
    const screen = await render(
      <div>
        {([16, 20, 24, 32, 40, 56] as const).map(size => (
          <Tile key={size} size={size} icon={ShieldCheck} />
        ))}
        <Tile size={16} plain icon={ShieldCheck} />
      </div>,
    )
    // A glyph is 60% of its tile (9.6 to 33.6px), but its line is set on the screen, not scaled with it: a Lucide glyph
    // draws every line with a non-scaling stroke at the width the tile gives.
    const glyphs = Array.from(screen.container.querySelectorAll<SVGSVGElement>('.ui-tile-face svg'))
    expect(glyphs.map(glyph => Number(glyph.getAttribute('stroke-width')))).toEqual([1.2, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5])
    for (const glyph of glyphs) {
      expect([...glyph.querySelectorAll('path')].every(line => line.getAttribute('vector-effect') === 'non-scaling-stroke')).toBe(true)
    }
  })

  it("shows the brand's own dark file in the dark theme, by preference or by choice", async () => {
    const screen = await render(<Tile size={32} mark={{ src: COLOUR_MARK, dark: MONO_MARK }} />)
    const shown = () =>
      Array.from(screen.container.querySelectorAll<HTMLImageElement>('.ui-tile img'))
        .filter(image => getComputedStyle(image).display !== 'none')
        .map(image => image.getAttribute('src'))
    expect(shown()).toEqual([COLOUR_MARK])
    await emulateMedia({ 'prefers-color-scheme': 'dark' }, () => {
      expect(shown()).toEqual([MONO_MARK])
      // A page that chose light keeps the light file under a dark system preference.
      document.documentElement.dataset.theme = 'light'
      try {
        expect(shown()).toEqual([COLOUR_MARK])
      } finally {
        delete document.documentElement.dataset.theme
      }
    })
    document.documentElement.dataset.theme = 'dark'
    try {
      expect(shown()).toEqual([MONO_MARK])
    } finally {
      delete document.documentElement.dataset.theme
    }
  })

  it('shows an app icon whole, without the plate, the ring or our corners, and lets a file with its own margin span the plate', async () => {
    const screen = await render(
      <div>
        <Tile size={32} mark={{ src: COLOUR_MARK, tile: true }} />
        <Tile size={32} mark={{ src: COLOUR_MARK, margin: true }} />
        <Tile size={32} mark={{ src: COLOUR_MARK }} />
      </div>,
    )
    const [app, margin, plain] = Array.from(screen.container.querySelectorAll('.ui-tile-face'), face => getComputedStyle(face))
    expect([app?.backgroundColor, app?.borderTopLeftRadius, app?.overflow]).toEqual(['rgba(0, 0, 0, 0)', '0px', 'visible'])
    expect(getComputedStyle(screen.container.querySelector('.ui-tile-face')!, '::after').content).toBe('none')
    expect(margin?.backgroundColor).toBe('rgb(255, 255, 255)')
    // A mark sits at 72% of its tile; a file with its own margin, and an app icon, span it.
    const widths = Array.from(
      screen.container.querySelectorAll('.ui-tile img'),
      image => Math.round(image.getBoundingClientRect().width * 10) / 10,
    )
    expect(widths).toEqual([32, 32, 23])
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
    expect(getComputedStyle(screen.container.querySelector('.ui-tile-dot')!).backgroundColor).toBe('rgb(180, 35, 31)')
  })

  it('pauses a skeleton and a tile arc out of view, and keeps them going in view', async () => {
    const screen = await render(
      <div style={{ height: 80, overflow: 'auto' }} data-testid="scroller">
        <div style={{ height: 400 }} />
        <Skeleton width={120} />
        <Tile mark={{ src: MONO_MARK, mono: true }} state="arriving" />
      </div>,
    )
    const loops = [screen.container.querySelector('.ui-skeleton')!, screen.container.querySelector('.ui-tile-progress-arc')!]
    const states = () => loops.map(loop => loop.getAnimations()[0]?.playState)
    await expect.poll(states).toEqual(['paused', 'paused'])
    screen.getByTestId('scroller').element().scrollTop = 400
    await expect.poll(states).toEqual(['running', 'running'])
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

  it("starts the progress arc at 12 o'clock, turns an indeterminate ring, and holds it still when motion is reduced", async () => {
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
    const turning = getComputedStyle(indeterminate)
    expect([turning.animationName, turning.animationDuration, turning.animationIterationCount]).toEqual([
      'ui-tile-progress',
      '1.4s',
      'infinite',
    ])
    expect(getComputedStyle(determinate).animationName).toBe('none')
    await emulateMedia({ 'prefers-reduced-motion': 'reduce' }, () => {
      // Still, the arc keeps its quarter, which reads as being checked.
      expect(getComputedStyle(indeterminate).animationName).toBe('none')
      expect(indeterminate.getAttribute('stroke-dasharray')).toBe('25 100')
    })
  })

  it('cuts a dot or a count out in the colour of the layer it sits on, in both themes', async () => {
    const screen = await render(
      <div>
        <div className="ui-popover" role="dialog">
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
    await emulateMedia({ 'prefers-color-scheme': 'dark' }, () => {
      expect(cutOuts()).toEqual([true, true, true, true])
      // In the dark theme a layer's pop face (#27272c) is lighter than the canvas (#131316): the ring is not the canvas's.
      const dot = screen.container.querySelector('.ui-popover .ui-tile-dot')!
      expect(getComputedStyle(dot).boxShadow).toMatch(/^rgb\(39, 39, 44\) /u)
    })
  })
})
