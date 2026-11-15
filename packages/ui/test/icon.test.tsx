import { Plug } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { FolderGlyph, ICON_STROKE, Icon, LATCH_GLYPHS, SMALL_GLYPHS, TerminalGlyph, type IconSize } from '../src/index.ts'

const SIZES = Object.keys(ICON_STROKE).map(Number) as IconSize[]

describe('icons', () => {
  it("draws a Latch glyph on its 16 grid at the size's on-screen line, with square ends and mitred joints", async () => {
    const screen = await render(
      <div>
        {SIZES.map(size => (
          <Icon key={size} icon={FolderGlyph} size={size} />
        ))}
      </div>,
    )
    const glyphs = [...screen.container.querySelectorAll('svg')]
    expect(glyphs.map(glyph => glyph.getAttribute('viewBox'))).toEqual(SIZES.map(() => '0 0 16 16'))
    // A unit of the grid is size / 16 pixels, so the line on the screen is the stroke times that.
    const onScreen = glyphs.map(
      (glyph, index) => Math.round(((Number(glyph.getAttribute('stroke-width')) * SIZES[index]!) / 16) * 100) / 100,
    )
    expect(onScreen).toEqual(SIZES.map(size => ICON_STROKE[size]))
    expect(glyphs.map(glyph => glyph.getBoundingClientRect().width)).toEqual(SIZES)
    for (const glyph of glyphs) {
      expect(glyph.getAttribute('stroke-linecap')).toBe('butt')
      expect(glyph.getAttribute('stroke-linejoin')).toBe('miter')
      expect(glyph.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('widens the line with the icon and never thins it as the icon grows', () => {
    const widths = SIZES.map(size => ICON_STROKE[size])
    expect(widths.every((width, index) => index === 0 || width >= widths[index - 1]!)).toBe(true)
    expect(widths[0]).toBeLessThan(widths.at(-1)!)
  })

  it('holds the v9 set: the redrawn glyphs, the new ones, and a second drawing at 12px for exactly those that say so', async () => {
    const names = Object.keys(LATCH_GLYPHS)
    const redrawn = [
      'running',
      'unknown',
      'branch',
      'laptop',
      'pull-request',
      'merged',
      'overview',
      'face',
      'settings',
      'schedule',
      'model',
    ]
    const added = ['failed', 'project', 'shield-half', 'shield-off', 'shield-unknown', 'clip']
    expect([...redrawn, ...added].filter(name => !names.includes(name))).toEqual([])
    expect(SMALL_GLYPHS.filter(name => !names.includes(name))).toEqual([])
    const screen = await render(
      <div>
        {names.map(name => (
          <span key={name} data-name={name}>
            <Icon icon={LATCH_GLYPHS[name as keyof typeof LATCH_GLYPHS]} size={12} />
            <Icon icon={LATCH_GLYPHS[name as keyof typeof LATCH_GLYPHS]} size={14} />
            <Icon icon={LATCH_GLYPHS[name as keyof typeof LATCH_GLYPHS]} size={16} />
          </span>
        ))}
      </div>,
    )
    // A glyph with a 12px drawing shows it at 12 only; every other glyph is one drawing at every size.
    const differing = [...screen.container.querySelectorAll<HTMLElement>('[data-name]')]
      .filter(group => {
        const [small, middle, regular] = [...group.querySelectorAll('svg')].map(glyph => glyph.innerHTML)
        expect(middle, group.dataset.name).toBe(regular)
        return small !== regular
      })
      .map(group => group.dataset.name)
    expect(differing.toSorted()).toEqual([...SMALL_GLYPHS].toSorted())
  })

  it('draws the v9 glyphs by their rules: nodes on one pair of lines, rows on whole pixels, one solid part', async () => {
    const screen = await render(
      <div>
        {(['branch', 'pull-request', 'merged', 'overview', 'settings', 'running', 'laptop'] as const).map(name => (
          <span key={name} data-name={name}>
            <Icon icon={LATCH_GLYPHS[name]} size={16} />
          </span>
        ))}
      </div>,
    )
    const glyph = (name: string) => screen.container.querySelector(`[data-name="${name}"] svg`)!
    const solids = (name: string) => [...glyph(name).querySelectorAll('[fill="currentColor"]')]
    // The three graph glyphs keep their open nodes on x = 4.25 and their one solid node on x = 11.75.
    for (const name of ['branch', 'pull-request', 'merged']) {
      expect(
        [...glyph(name).querySelectorAll('circle')].map(node => node.getAttribute('cx')),
        name,
      ).toEqual(['4.25', '4.25'])
      expect(
        solids(name).map(node => Number(node.getAttribute('x')) + Number(node.getAttribute('width')) / 2),
        name,
      ).toEqual([11.75])
    }
    // 总览's rows sit on 4.25, 8 and 11.75; 设置 keeps one solid knob; 进行中 has a head, not a faded ring.
    expect(glyph('overview').querySelector('path')!.getAttribute('d')).toMatch(/M6\.75 4\.25 H14 .*M6\.75 8 H14 .*M6\.75 11\.75 H11\.5/u)
    expect(solids('settings')).toHaveLength(1)
    expect(solids('running')).toHaveLength(1)
    expect(glyph('running').querySelector('[opacity]')).toBeNull()
    // The laptop's screen is open at the bottom and stands on the base line: no closed rectangle floating over it.
    expect(glyph('laptop').querySelector('rect')).toBeNull()
  })

  it('draws a Lucide glyph of the long tail at the same on-screen line, without scaling it from its 24 grid', async () => {
    const screen = await render(<Icon icon={Plug} size={12} />)
    const glyph = screen.container.querySelector('svg')!
    expect(glyph.getAttribute('stroke-width')).toBe(String(ICON_STROKE[12]))
    expect([...glyph.querySelectorAll('path')].every(line => line.getAttribute('vector-effect') === 'non-scaling-stroke')).toBe(true)
  })

  it('shows the solid variant for the selected item, and leaves a Lucide glyph as it is', async () => {
    const screen = await render(
      <div>
        <Icon icon={TerminalGlyph} />
        <Icon icon={TerminalGlyph} solid />
        <Icon icon={TerminalGlyph} solid label="终端" />
        <Icon icon={Plug} solid />
      </div>,
    )
    const [outline, solid, named, lucide] = [...screen.container.querySelectorAll('svg')]
    expect(outline!.classList.contains('latch-glyph-solid')).toBe(false)
    expect(solid!.classList.contains('latch-glyph-solid')).toBe(true)
    // The terminal's plane is cut by its prompt and cursor through a mask of its own, one per glyph on the page.
    const masks = [solid!, named!].map(glyph => glyph.querySelector('mask')?.id)
    expect(masks.every(Boolean)).toBe(true)
    expect(new Set(masks).size).toBe(2)
    expect(named!.getAttribute('role')).toBe('img')
    expect(named!.getAttribute('aria-label')).toBe('终端')
    expect(lucide!.classList.contains('lucide-plug')).toBe(true)
  })

  it('gives every Latch glyph a solid variant that draws something', async () => {
    const screen = await render(
      <div>
        {Object.entries(LATCH_GLYPHS).map(([name, glyph]) => (
          <span key={name} data-name={name}>
            <Icon icon={glyph} size={24} />
            <Icon icon={glyph} size={24} solid />
          </span>
        ))}
      </div>,
    )
    for (const pair of screen.container.querySelectorAll<HTMLElement>('[data-name]')) {
      const [outline, solid] = [...pair.querySelectorAll('svg')]
      expect(solid!.classList.contains('latch-glyph-solid'), pair.dataset.name).toBe(true)
      expect(
        solid!.innerHTML === outline!.innerHTML && solid!.getAttribute('stroke-width') === outline!.getAttribute('stroke-width'),
        pair.dataset.name,
      ).toBe(false)
      const box = [...solid!.querySelectorAll('path, rect, circle')].find(part => !part.closest('mask'))!.getBoundingClientRect()
      expect(box.width + box.height, pair.dataset.name).toBeGreaterThan(0)
    }
  })
})
