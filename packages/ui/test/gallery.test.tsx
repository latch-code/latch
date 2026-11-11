import { describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import layout from './gallery/layout.css?inline'
import { Gallery } from './gallery/Gallery.tsx'
import { emulateMedia } from './helpers.ts'

/** Every class the primitives' stylesheets style. */
const styled = new Set(
  Object.values(import.meta.glob<string>('../src/styles/*.css', { query: '?raw', import: 'default', eager: true })).flatMap(text =>
    Array.from(text.matchAll(/\.(ui-[a-z-]+)/gu), match => match[1] ?? ''),
  ),
)

describe('gallery of the primitives', () => {
  it('shows every primitive the stylesheets draw', async () => {
    // The gallery's layout holds a few cross-fades halfway, so what leaves in them stays to be seen.
    const sheet = document.createElement('style')
    sheet.textContent = `@layer app { ${layout} }`
    document.head.append(sheet)
    try {
      const screen = await render(<Gallery />)
      await expect.element(screen.getByRole('main', { name: '@latch/ui' })).toBeVisible()
      expect(styled.size).toBeGreaterThan(100)
      // The cross-fades of the status vocabulary replay a frame after the gallery mounts.
      await expect.poll(() => [...styled].filter(name => document.getElementsByClassName(name).length === 0)).toEqual([])
    } finally {
      sheet.remove()
    }
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

  it('lifts the accent and turns the surfaces in the dark theme', async () => {
    const screen = await render(<Gallery />)
    const primary = () => getComputedStyle(screen.getByRole('button', { name: '允许一次' }).first().element()).backgroundColor
    const surface = () => getComputedStyle(screen.container.querySelector('.ui-dialog-surface')!).backgroundColor
    expect([primary(), surface()]).toEqual(['rgb(36, 97, 224)', 'rgb(255, 255, 255)'])
    await emulateMedia({ 'prefers-color-scheme': 'dark' }, async () => {
      // The button's fill eases over --m-micro when the system flips (a page switches without it, theme.ts).
      await expect.poll(() => [primary(), surface()]).toEqual(['rgb(47, 107, 230)', 'rgb(27, 27, 31)'])
    })
  })

  it('holds the loops still and keeps only short fades when motion is reduced', async () => {
    const screen = await render(<Gallery />)
    await emulateMedia({ 'prefers-reduced-motion': 'reduce' }, () => {
      // The spinner and the thinking shimmer stand on their still frames.
      expect(getComputedStyle(screen.container.querySelector('.ui-spinner')!).animationName).toBe('none')
      expect(getComputedStyle(screen.container.querySelector('.ui-shimmer')!).animationName).toBe('none')
      // Transitions keep only fades and colour changes, at 120ms or less; nothing moves or scales.
      for (const selector of ['.ui-switch-thumb', '.ui-button', '.ui-collapse']) {
        const style = getComputedStyle(screen.container.querySelector(selector)!)
        expect(style.transitionProperty, selector).not.toMatch(/translate|transform|scale|grid-template-rows|width/u)
        expect(
          style.transitionDuration.split(', ').every(value => parseFloat(value) <= 0.12),
          selector,
        ).toBe(true)
      }
    })
  })
})
