import { afterEach, describe, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'

import { revealScrollbarsWhileScrolling } from '../src/index.ts'
import { emulateMedia } from './helpers.ts'

const alphaOf = (el: Element) => Number.parseFloat(getComputedStyle(el).getPropertyValue('--ui-scroll-alpha'))
const scrollbarAnimations = (el: Element) => el.getAnimations().filter(item => item.id === 'ui-scrollbar')
const movePointer = (target: EventTarget, x: number, y: number) =>
  target.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y, pointerType: 'mouse' }))

function makeScroller(height = 80, width = 200): HTMLDivElement {
  const list = document.createElement('div')
  // Headless Chromium hides scrollbars by default. Reserve their actual CSS width for the hit tests.
  list.style.cssText = `width: ${width}px; height: ${height}px; overflow-y: auto; scrollbar-gutter: stable`
  list.append(Object.assign(document.createElement('div'), { style: 'height: 400px' }))
  document.body.append(list)
  return list
}

async function holdOnTrack(list: HTMLElement) {
  await userEvent.hover(list, { position: { x: list.offsetWidth - 4, y: 30 } })
  list.scrollTop = 40
  await expect.poll(() => list.classList.contains('ui-scrolling')).toBe(true)
  await new Promise(done => setTimeout(done, 900))
  expect(alphaOf(list)).toBe(1)
}

describe('revealScrollbarsWhileScrolling', () => {
  let stop: (() => void) | undefined
  afterEach(() => {
    stop?.()
    stop = undefined
    delete document.documentElement.dataset.motion
    delete document.documentElement.dataset.capture
    document.body.replaceChildren()
  })

  it('reveals while scrolling and smoothly fades out through --ui-scroll-alpha once idle', async () => {
    stop = revealScrollbarsWhileScrolling()
    const list = makeScroller()
    const away = Object.assign(document.createElement('div'), {
      style: 'position: fixed; right: 0; bottom: 0; width: 16px; height: 16px',
    })
    document.body.append(away)
    await userEvent.hover(away)

    expect(list.classList.contains('ui-scrolling')).toBe(false)
    expect(alphaOf(list)).toBe(0)

    list.scrollTop = 60
    await expect.poll(() => list.classList.contains('ui-scrolling')).toBe(true)
    await expect.poll(() => alphaOf(list)).toBe(1)

    // Once idle, `.ui-scrolling` drops and a finite WAAPI fade lowers `--ui-scroll-alpha` smoothly to 0.
    await expect.poll(() => list.classList.contains('ui-scrolling'), { timeout: 2000 }).toBe(false)
    const fade = scrollbarAnimations(list)[0]
    expect(fade).toBeDefined()
    expect(fade?.effect?.getComputedTiming().duration).toBe(320)
    await expect.poll(() => alphaOf(list), { timeout: 2000 }).toBe(0)
    expect(scrollbarAnimations(list)).toHaveLength(0)
  })

  it('fades out after idle even when the pointer rests over the scrollable content', async () => {
    stop = revealScrollbarsWhileScrolling()
    const list = makeScroller(120, 240)
    const rect = list.getBoundingClientRect()
    expect(list.offsetWidth - list.clientWidth).toBe(10)
    const x = rect.left + list.clientWidth - 1
    const y = rect.top + 40
    expect(document.elementFromPoint(x, y)).toBe(list.firstElementChild)
    movePointer(list, x, y)

    list.scrollTop = 80
    await expect.poll(() => list.classList.contains('ui-scrolling')).toBe(true)
    await expect.poll(() => list.classList.contains('ui-scrolling'), { timeout: 2000 }).toBe(false)
    await expect.poll(() => alphaOf(list), { timeout: 2000 }).toBe(0)
  })

  it('holds the thumb while the pointer stays on the scrollbar track and fades once it leaves', async () => {
    stop = revealScrollbarsWhileScrolling()
    const list = makeScroller(120, 240)
    const rect = list.getBoundingClientRect()
    movePointer(list, rect.right - 4, rect.top + 30)

    list.scrollTop = 80
    await expect.poll(() => list.classList.contains('ui-scrolling')).toBe(true)
    await new Promise(done => setTimeout(done, 900))
    expect(list.classList.contains('ui-scrolling')).toBe(true)
    expect(alphaOf(list)).toBe(1)

    // Moving off the scrollbar strip back into the content starts the fade-out smoothly.
    movePointer(list, rect.left + 40, rect.top + 30)
    expect(list.classList.contains('ui-scrolling')).toBe(false)
    expect(scrollbarAnimations(list).length).toBeGreaterThan(0)
    await expect.poll(() => alphaOf(list), { timeout: 2000 }).toBe(0)
  })

  it('interrupts an in-progress fade-out when scrolling resumes or the pointer enters the scrollbar track', async () => {
    stop = revealScrollbarsWhileScrolling()
    const list = makeScroller(120, 240)
    const rect = list.getBoundingClientRect()
    movePointer(list, rect.left + 40, rect.top + 40)

    list.scrollTop = 60
    await expect.poll(() => list.classList.contains('ui-scrolling')).toBe(true)
    await expect.poll(() => list.classList.contains('ui-scrolling'), { timeout: 2000 }).toBe(false)
    expect(scrollbarAnimations(list).length).toBeGreaterThan(0)

    // Resume scrolling mid-fade: returns smoothly to visible without staying hidden.
    list.scrollTop = 120
    await expect.poll(() => list.classList.contains('ui-scrolling')).toBe(true)
    await expect.poll(() => alphaOf(list)).toBe(1)

    // Let it start fading again, then move onto the scrollbar track to rescue it.
    await expect.poll(() => list.classList.contains('ui-scrolling'), { timeout: 2000 }).toBe(false)
    movePointer(list, rect.right - 4, rect.top + 30)
    expect(list.classList.contains('ui-scrolling')).toBe(true)
    await expect.poll(() => alphaOf(list)).toBe(1)
  })

  it('keeps a nested scrollable child hidden while its parent scrolls or fades', async () => {
    stop = revealScrollbarsWhileScrolling()
    const parent = makeScroller(160, 240)
    const child = document.createElement('div')
    child.style.cssText = 'width: 160px; height: 60px; overflow-y: auto'
    child.append(Object.assign(document.createElement('div'), { style: 'height: 300px' }))
    parent.prepend(child)

    parent.scrollTop = 40
    await expect.poll(() => parent.classList.contains('ui-scrolling')).toBe(true)
    await expect.poll(() => alphaOf(parent)).toBe(1)
    expect(alphaOf(child)).toBe(0)
  })

  it('releases a held inner scrollbar when the outer list scrolls it away from a stationary pointer', async () => {
    stop = revealScrollbarsWhileScrolling()
    const outer = makeScroller(160, 240)
    const inner = makeScroller(60, 160)
    outer.prepend(inner)
    await holdOnTrack(inner)

    outer.scrollTop = 100
    expect(inner.getBoundingClientRect().bottom).toBeLessThan(outer.getBoundingClientRect().top)
    await expect.poll(() => alphaOf(inner), { timeout: 2000 }).toBe(0)
  })

  it('fades out when the list shifts from its track to its content under a stationary pointer', async () => {
    stop = revealScrollbarsWhileScrolling()
    const list = makeScroller()
    await holdOnTrack(list)
    const { right, top } = list.getBoundingClientRect()
    list.style.marginLeft = '30px'
    expect(document.elementFromPoint(right - 4, top + 30)).toBe(list.firstElementChild)
    await expect.poll(() => alphaOf(list), { timeout: 2000 }).toBe(0)
  })

  it.each(['scrolling', 'held'])('clears the reveal when a %s element is detached and later reused', async state => {
    stop = revealScrollbarsWhileScrolling()
    const list = makeScroller()
    if (state === 'held') await holdOnTrack(list)
    else {
      list.scrollTop = 40
      await expect.poll(() => list.classList.contains('ui-scrolling')).toBe(true)
    }
    list.remove()
    await expect.poll(() => list.classList.contains('ui-scrolling'), { timeout: 2000 }).toBe(false)
    document.body.append(list)
    expect(alphaOf(list)).toBe(0)
  })

  it('returns scrollbar rendering to the platform when forced colors are active', async () => {
    stop = revealScrollbarsWhileScrolling()
    const list = makeScroller()
    list.scrollTop = 40
    await expect.poll(() => list.classList.contains('ui-scrolling')).toBe(true)

    await emulateMedia({ 'forced-colors': 'active' }, async () => {
      await expect.poll(() => list.classList.contains('ui-scrolling')).toBe(false)
      expect(scrollbarAnimations(list)).toHaveLength(0)
      list.dispatchEvent(new Event('scroll'))
      expect(list.classList.contains('ui-scrolling')).toBe(false)
      expect(scrollbarAnimations(list)).toHaveLength(0)
    })

    // The browser delivers the restored media query's change event before the next animation frame.
    await new Promise(requestAnimationFrame)
    list.scrollTop = 80
    await expect.poll(() => list.classList.contains('ui-scrolling')).toBe(true)
  })

  it('hides without animating under reduced motion or still capture', async () => {
    stop = revealScrollbarsWhileScrolling()
    const list = makeScroller()
    const rect = list.getBoundingClientRect()
    movePointer(list, rect.left + 40, rect.top + 20)

    document.documentElement.dataset.motion = 'reduce'
    list.scrollTop = 50
    await expect.poll(() => list.classList.contains('ui-scrolling')).toBe(true)
    expect(scrollbarAnimations(list)).toHaveLength(0)
    await expect.poll(() => list.classList.contains('ui-scrolling'), { timeout: 2000 }).toBe(false)
    expect(scrollbarAnimations(list)).toHaveLength(0)
    expect(alphaOf(list)).toBe(0)

    delete document.documentElement.dataset.motion
    await emulateMedia({ 'prefers-reduced-motion': 'reduce' }, async () => {
      list.scrollTop = 100
      await expect.poll(() => list.classList.contains('ui-scrolling')).toBe(true)
      await expect.poll(() => list.classList.contains('ui-scrolling'), { timeout: 2000 }).toBe(false)
      expect(scrollbarAnimations(list)).toHaveLength(0)
    })

    document.documentElement.dataset.capture = 'still'
    list.scrollTop = 140
    await expect.poll(() => list.classList.contains('ui-scrolling')).toBe(true)
    await expect.poll(() => list.classList.contains('ui-scrolling'), { timeout: 2000 }).toBe(false)
    expect(scrollbarAnimations(list)).toHaveLength(0)
  })
})
