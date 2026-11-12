import { Plug } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { FolderGlyph, ICON_STROKE, Icon, LATCH_GLYPHS, TerminalGlyph, type IconSize } from '../src/index.ts'

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
