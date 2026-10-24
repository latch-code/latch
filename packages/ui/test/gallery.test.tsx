import { describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import layout from './gallery/layout.css?inline'
import { Gallery } from './gallery/Gallery.tsx'
import { protocol } from './helpers.ts'

/** Every class the primitives' stylesheets style. */
const styled = new Set(
  Object.values(import.meta.glob<string>('../src/styles/*.css', { query: '?raw', import: 'default', eager: true })).flatMap(text =>
    Array.from(text.matchAll(/\.(ui-[a-z-]+)/gu), match => match[1] ?? ''),
  ),
)

describe('gallery of the primitives', () => {
  it('shows every primitive the stylesheets draw', async () => {
    const screen = await render(<Gallery />)
    await expect.element(screen.getByRole('main', { name: '@latch/ui' })).toBeVisible()
    expect(styled.size).toBeGreaterThan(100)
    // The one-shots of the live indicators replay a frame after the gallery mounts.
    await expect.poll(() => [...styled].filter(name => document.getElementsByClassName(name).length === 0)).toEqual([])
  })

  it('names every control it shows', async () => {
    const screen = await render(<Gallery />)
    const unnamed = Array.from(
      screen.container.querySelectorAll<HTMLElement>('button, input, [role="switch"], [role="radio"], [role="tab"]'),
    ).filter(
      control =>
        !control.getAttribute('aria-label')
        && !control.getAttribute('aria-labelledby')
        && !control.textContent?.trim()
        && !(control instanceof HTMLInputElement && control.labels && control.labels.length > 0),
    )
    expect(unnamed.map(control => control.outerHTML.slice(0, 80))).toEqual([])
  })

  it("keeps the primitives' own title type under the gallery's layout", async () => {
    // The gallery's layout, in the app layer above the primitives, as the gallery page loads it.
    const sheet = document.createElement('style')
    sheet.textContent = `@layer app { ${layout} }`
    document.head.append(sheet)
    try {
      const screen = await render(<Gallery />)
      const titles = Array.from(screen.container.querySelectorAll('.ui-dialog-title, .ui-sheet-title, .ui-error-state-title'), title => {
        const style = getComputedStyle(title)
        return [style.fontSize, style.lineHeight, style.fontWeight, style.color].join(' ')
      })
      expect(titles.length).toBeGreaterThan(4)
      expect(new Set(titles)).toEqual(new Set([`15px 22px 600 ${getComputedStyle(document.documentElement).color}`]))
    } finally {
      sheet.remove()
    }
  })

  it('shows every dialog, sheet and layer whole inside its card at phone width', async () => {
    const sheet = document.createElement('style')
    sheet.textContent = `@layer app { ${layout} }`
    document.head.append(sheet)
    await page.viewport(390, 844)
    try {
      const screen = await render(<Gallery />)
      // The ones drawn in place; the live pickers' closed sheets and layers are not shown.
      const surfaces = Array.from(screen.container.querySelectorAll('.ui-dialog-surface, .ui-popover, .ui-sheet-surface')).filter(surface =>
        surface.checkVisibility(),
      )
      expect(surfaces.length).toBeGreaterThan(10)
      const clipped = surfaces.filter(surface => {
        const card = surface.closest('.gallery-card')!
        const style = getComputedStyle(card)
        const outer = card.getBoundingClientRect()
        const inner = {
          left: outer.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
          right: outer.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
        }
        const box = surface.getBoundingClientRect()
        return box.left < inner.left - 0.5 || box.right > inner.right + 0.5
      })
      expect(clipped.map(surface => surface.textContent?.slice(0, 20))).toEqual([])
    } finally {
      await page.viewport(1280, 800)
      sheet.remove()
    }
  })

  it('keeps the accent and turns the surfaces in the dark theme', async () => {
    const screen = await render(<Gallery />)
    const primary = () => getComputedStyle(screen.getByRole('button', { name: '允许一次' }).first().element()).backgroundColor
    const surface = () => getComputedStyle(screen.container.querySelector('.ui-dialog-surface')!).backgroundColor
    expect([primary(), surface()]).toEqual(['rgb(36, 97, 224)', 'rgb(255, 255, 255)'])
    await protocol().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] })
    try {
      expect([primary(), surface()]).toEqual(['rgb(36, 97, 224)', 'rgb(37, 36, 35)'])
    } finally {
      await protocol().send('Emulation.setEmulatedMedia', { features: [] })
    }
  })

  it('keeps the spinner turning and drops the movement of layers when motion is reduced', async () => {
    const screen = await render(<Gallery />)
    await protocol().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    try {
      const spinner = screen.container.querySelector('.ui-spinner')!
      expect(getComputedStyle(spinner).animationDuration).toBe('0.9s')
      expect(getComputedStyle(spinner).animationIterationCount).toBe('infinite')
      const thumb = screen.container.querySelector('.ui-segmented-thumb')!
      expect(getComputedStyle(thumb).transitionDuration).toBe('0.001s')
    } finally {
      await protocol().send('Emulation.setEmulatedMedia', { features: [] })
    }
  })
})
