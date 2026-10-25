import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { AmbientField } from '../src/index.ts'

/** An empty page: a title the orbits circle, an input it keeps clear of and a primary button it keeps further from. */
function Page({ still = false }: { still?: boolean }) {
  return (
    <div style={{ position: 'relative', width: 1000, height: 760, background: 'var(--bg-pane)' }} data-testid="page">
      <AmbientField still={still} />
      <h2 data-ambient-anchor="" data-ambient-avoid="text" style={{ position: 'absolute', left: 400, top: 180, width: 200, height: 32 }}>
        今天要做什么？
      </h2>
      <div data-ambient-avoid="surface" style={{ position: 'absolute', left: 120, top: 260, width: 760, height: 140 }}>
        <textarea aria-label="新会话消息" />
      </div>
      <button type="button" data-ambient-avoid="accent" style={{ position: 'absolute', left: 440, top: 440, width: 120, height: 28 }}>
        添加
      </button>
    </div>
  )
}

const canvasOf = (container: HTMLElement) => container.querySelector<HTMLCanvasElement>('canvas.ui-ambient')!
const state = (container: HTMLElement) => canvasOf(container).dataset.state

/**
 * The largest alpha drawn within `margin` CSS px of a rectangle of the page (all of it when the margin is Infinity),
 * read from the canvas.
 */
function inkNear(canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number, margin: number): number {
  const scale = canvas.width / canvas.getBoundingClientRect().width
  const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  let max = 0
  for (let row = 0; row < canvas.height; row++) {
    for (let column = 0; column < canvas.width; column++) {
      const [px, py] = [column / scale, row / scale]
      const distance = Math.hypot(Math.max(x - px, 0, px - (x + w)), Math.max(y - py, 0, py - (y + h)))
      if (distance <= margin) max = Math.max(max, data[(row * canvas.width + column) * 4 + 3])
    }
  }
  return max
}

/**
 * Runs with this frame asking for reduced motion. The page's media emulation is shared with other test files running
 * at the same time, so the field's query is answered here instead, for this frame only.
 */
async function reduced<T>(run: () => Promise<T>): Promise<T> {
  const original = window.matchMedia
  window.matchMedia = (query: string) => {
    const list = original.call(window, query)
    if (query !== '(prefers-reduced-motion: reduce)') return list
    // The real list (its listeners), answering that reduced motion is asked for.
    return new Proxy(list, {
      get: (target, key) => {
        if (key === 'matches') return true
        const value: unknown = Reflect.get(target, key, target)
        return typeof value === 'function' ? (value.bind(target) as unknown) : value
      },
    })
  }
  try {
    return await run()
  } finally {
    window.matchMedia = original
  }
}

describe('ambient field', () => {
  it('is one canvas under the content, at most twice the CSS size, that never takes the pointer', async () => {
    const screen = await render(<Page />)
    const canvas = canvasOf(screen.container)
    expect(screen.container.querySelectorAll('canvas')).toHaveLength(1)
    const box = canvas.getBoundingClientRect()
    expect([box.width, box.height]).toEqual([1000, 760])
    expect(canvas.width).toBeLessThanOrEqual(2000)
    expect(canvas.width).toBe(Math.round(1000 * Math.min(2, devicePixelRatio)))
    expect(getComputedStyle(canvas).pointerEvents).toBe('none')
    expect(canvas.getAttribute('aria-hidden')).toBe('true')
  })

  it('draws the opening pose and nothing else under reduced motion, the same frame every time, clear of the content', async () => {
    const first = await reduced(async () => {
      const screen = await render(<Page />)
      await expect.poll(() => state(screen.container)).toBe('still')
      const canvas = canvasOf(screen.container)
      // Something is drawn, and none of it within the margin round the input or the button.
      expect(inkNear(canvas, 0, 0, 1000, 760, Infinity)).toBeGreaterThan(0)
      // The most ink anywhere is the lift (at most .32 of the ink, 66 levels from the paper): a lifted station does not
      // stack over its resting dot and the light's line.
      expect(inkNear(canvas, 0, 0, 1000, 760, Infinity)).toBeLessThanOrEqual(Math.round(0.32 * 255) + 1)
      expect(inkNear(canvas, 120, 260, 760, 140, 80)).toBe(0)
      expect(inkNear(canvas, 440, 440, 120, 28, 110)).toBe(0)
      expect(document.getAnimations()).toEqual([])
      const pixels = canvas.toDataURL()
      await screen.unmount()
      return pixels
    })
    const again = await render(<Page still />)
    await expect.poll(() => state(again.container)).toBe('still')
    expect(canvasOf(again.container).toDataURL()).toBe(first)
  })

  it('runs a pass, dims and stops while the input has focus, and pauses under an open dialog', async () => {
    const screen = await render(<Page />)
    // The field moves only while its window has focus: a press on the page gives it.
    await screen.getByRole('heading', { name: '今天要做什么？' }).click()
    await expect.poll(() => state(screen.container)).toBe('pass')
    const canvas = canvasOf(screen.container)
    const textarea = screen.container.querySelector('textarea')!
    textarea.focus()
    await expect.poll(() => state(screen.container)).toBe('quiet')
    await expect.poll(() => getComputedStyle(canvas).opacity).toBe('0.45')
    const quiet = canvas.toDataURL()
    await new Promise(done => setTimeout(done, 300))
    expect(canvas.toDataURL()).toBe(quiet)
    textarea.blur()
    await expect.poll(() => state(screen.container)).toBe('rest')
    const dialog = document.createElement('dialog')
    document.body.append(dialog)
    dialog.showModal()
    try {
      await expect.poll(() => state(screen.container), { timeout: 3000 }).toBe('paused')
    } finally {
      dialog.close()
      dialog.remove()
    }
    await expect.poll(() => state(screen.container)).not.toBe('paused')
  })
})
