import { expect, it } from 'vitest'
import { overlayCovers } from '../src/panel/browser/BrowserPanel.tsx'

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number }
const box = (left: number, top: number, width: number, height: number): Box => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
})

/** A page element: where it is, and whether it is (inside) a tooltip. */
function element(rect: Box, tooltip = false) {
  return {
    getBoundingClientRect: () => rect,
    closest: (selector: string) => (tooltip && selector === '[role="tooltip"]' ? {} : null),
    matches: (selector: string) => tooltip && selector === '[role="tooltip"]',
  }
}

const canvasRect = box(900, 100, 500, 700)
const inner = element(box(910, 110, 10, 10))
const canvas = { getBoundingClientRect: () => canvasRect, contains: (node: unknown) => node === inner } as unknown as HTMLElement

function page(top: unknown, layers: unknown[]) {
  return {
    elementFromPoint: () => top,
    querySelectorAll: () => layers,
  } as unknown as Pick<Document, 'elementFromPoint' | 'querySelectorAll'>
}

it('freezes the tab for a menu or dialog over the canvas, never for a tooltip there', () => {
  expect(overlayCovers(canvas, page(inner, []))).toBe(false)
  // 加入对话's tooltip, reaching over the canvas's bottom edge.
  const tooltip = element(box(1270, 780, 160, 26), true)
  expect(overlayCovers(canvas, page(inner, [tooltip]))).toBe(false)
  expect(overlayCovers(canvas, page(tooltip, [tooltip]))).toBe(false)
  // A menu or dialog over it hides the view.
  const menu = element(box(1200, 300, 200, 200))
  expect(overlayCovers(canvas, page(inner, [menu]))).toBe(true)
  expect(overlayCovers(canvas, page(menu, []))).toBe(true)
  // A layer elsewhere on the page does not.
  expect(overlayCovers(canvas, page(inner, [element(box(10, 10, 100, 100))]))).toBe(false)
})
