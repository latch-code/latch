import { useRef, type CSSProperties, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import {
  Backdrop,
  FRAME_INTERVAL,
  markStreaming,
  particleCount,
  type BackdropKind,
  type BackdropLevel,
  type BackdropStats,
} from '../src/index.ts'
import { IDLE_AFTER } from '../src/backdrop-engine.ts'
import { emulateMedia } from './helpers.ts'

const pause = (ms: number) => new Promise(done => setTimeout(done, ms))
type Reader = { read: (() => BackdropStats) | null }
const reader = (): Reader => ({ read: null })

/** A stage 400 × 300 with the layer behind an opaque card; `stats.read` reads the engine's counters once it runs. */
function Stage({
  kind = 'field',
  level = 'standard',
  running = 2,
  focus = false,
  secure = false,
  clear = false,
  resolved = null,
  ambient = false,
  stats,
  children,
  style,
}: {
  kind?: BackdropKind
  level?: BackdropLevel
  running?: number
  focus?: boolean
  secure?: boolean
  clear?: boolean
  resolved?: { id: number; x: number; y: number } | null
  ambient?: boolean
  stats: Reader
  children?: ReactNode
  style?: CSSProperties
}) {
  const card = useRef<HTMLDivElement>(null)
  return (
    <div className="ui-backdrop-host" data-testid="host" style={{ width: 400, height: 300, ...style }}>
      <Backdrop
        kind={kind}
        level={level}
        running={running}
        focus={focus}
        focusTarget={card}
        resolved={resolved}
        ambient={ambient}
        onStats={read => {
          stats.read = read
        }}
      />
      <div
        ref={card}
        data-testid="card"
        data-secure={secure ? '' : undefined}
        data-backdrop-clear={clear ? '' : undefined}
        style={{ position: 'absolute', left: 120, top: 100, width: 160, height: 100 }}>
        card
      </div>
      {children}
    </div>
  )
}

/** How many pixels of the canvas are drawn inside a box given in the canvas's own (unscaled) coordinates. */
function drawn(canvas: HTMLCanvasElement, box: { left: number; top: number; width: number; height: number }): number {
  const scale = canvas.width / canvas.clientWidth
  const data = canvas
    .getContext('2d')!
    .getImageData(
      Math.round(box.left * scale),
      Math.round(box.top * scale),
      Math.round(box.width * scale),
      Math.round(box.height * scale),
    ).data
  let count = 0
  for (let index = 3; index < data.length; index += 4) if (data[index]! > 0) count++
  return count
}

const WHOLE = { left: 0, top: 0, width: 400, height: 300 }
const CARD = { left: 120, top: 100, width: 160, height: 100 }
const CORNER = { left: 0, top: 0, width: 100, height: 80 }

/** A protected surface placed over the stage by hand after the layer started. */
function surface(
  host: Element,
  box: { left: number; top: number; width: number; height: number },
  mark: 'data-secure' | 'data-backdrop-clear' = 'data-secure',
): HTMLElement {
  const element = document.createElement('div')
  element.setAttribute(mark, '')
  element.style.cssText = `position: absolute; left: ${box.left}px; top: ${box.top}px; width: ${box.width}px; height: ${box.height}px`
  host.append(element)
  return element
}

beforeEach(() => {
  // The runner's iframe may be unfocused even when the test is exercising foreground motion.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  delete document.documentElement.dataset.motion
  delete document.documentElement.dataset.capture
})

describe('the background layer', () => {
  it('caps its particles by the viewport: more for 标准 than for 轻, fewer on a phone, never past the cap', () => {
    const [desktop, light] = [particleCount(1440, 900, 'standard'), particleCount(1440, 900, 'light')]
    expect(desktop).toBeGreaterThan(light)
    expect(particleCount(390, 844, 'standard')).toBeLessThan(desktop)
    expect(particleCount(390, 844, 'light')).toBeLessThan(light)
    // A wall of screens gets no more than the cap.
    const [most, mostLight] = [particleCount(7680, 4320, 'standard'), particleCount(7680, 4320, 'light')]
    expect([particleCount(15360, 8640, 'standard'), particleCount(15360, 8640, 'light')]).toEqual([most, mostLight])
    expect(mostLight).toBeLessThan(most)
    expect(particleCount(0, 0, 'standard')).toBe(0)
  })

  it('is one canvas of its own behind the content, out of the accessibility tree, the pointer and the layout', async () => {
    const stats = reader()
    const screen = await render(<Stage stats={stats} />)
    const canvases = screen.container.querySelectorAll('canvas')
    expect(canvases).toHaveLength(1)
    const style = getComputedStyle(canvases[0]!)
    expect(canvases[0]!.getAttribute('aria-hidden')).toBe('true')
    expect([style.position, style.zIndex, style.pointerEvents, style.contain]).toEqual(['absolute', '-1', 'none', 'strict'])
    // The card is what a pointer finds, whatever is drawn behind it.
    expect(document.elementFromPoint(...centre(screen.getByTestId('card').element()))).toBe(screen.getByTestId('card').element())
    expect(document.elementFromPoint(...corner(screen.getByTestId('host').element()))).toBe(screen.getByTestId('host').element())
  })

  it.for(['grid', 'field', 'glow'] as const)('draws 点阵, 粒子场 and 柔光 on that canvas (%s)', async kind => {
    const stats = reader()
    const screen = await render(<Stage kind={kind} stats={stats} />)
    const canvas = screen.container.querySelector('canvas')!
    await expect.poll(() => stats.read?.().frames ?? 0).toBeGreaterThan(0)
    await expect.poll(() => drawn(canvas, WHOLE)).toBeGreaterThan(0)
    expect(canvas.dataset.kind).toBe(kind)
  })

  it('renders nothing for 关, and draws nothing where the theme gives it no ink', async () => {
    const stats = reader()
    const screen = await render(<Stage level="off" stats={stats} />)
    expect(screen.container.querySelector('canvas')).toBeNull()
    expect(stats.read).toBeNull()
    await screen.unmount()
    // No colour of its own to fall back on: without the token the canvas stays empty.
    const bare = await render(<Stage kind="grid" stats={stats} style={{ ['--fx-ink' as string]: 'initial' }} />)
    await expect.poll(() => stats.read?.().frames ?? 0).toBeGreaterThan(1)
    expect(drawn(bare.container.querySelector('canvas')!, WHOLE)).toBe(0)
  })

  it('draws at most 30 frames a second from one timer and one animation frame each, and changes nothing in the document', async () => {
    const stats = reader()
    const screen = await render(<Stage stats={stats} />)
    await expect.poll(() => stats.read?.().frames ?? 0).toBeGreaterThan(1)
    const changes: MutationRecord[] = []
    const observer = new MutationObserver(records => changes.push(...records))
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
    const request = window.requestAnimationFrame
    let requested = 0
    window.requestAnimationFrame = callback => {
      requested++
      return request.call(window, callback)
    }
    const before = stats.read!().frames
    const started = performance.now()
    await pause(600)
    const elapsed = performance.now() - started
    const after = stats.read!()
    window.requestAnimationFrame = request
    observer.disconnect()
    expect(after.frames - before).toBeGreaterThan(2)
    expect(after.frames - before).toBeLessThanOrEqual(Math.ceil(elapsed / FRAME_INTERVAL) + 1)
    expect(after.minGap).toBeGreaterThanOrEqual(FRAME_INTERVAL - 1.5)
    // Never an animation frame per display refresh: about one for each frame it drew.
    expect(requested).toBeLessThanOrEqual(after.frames - before + 3)
    expect(after.points).toBeLessThanOrEqual(particleCount(400, 300, 'standard'))
    // The loop writes pixels only: no attribute, style, class or node changed anywhere, the canvas included.
    expect(changes.map(record => `${record.type} ${record.target.nodeName} ${record.attributeName ?? ''}`)).toEqual([])
    expect(screen.container.querySelector('canvas')!.getAttribute('style')).toBeNull()
  })

  it('keeps an ambient field drifting while nothing runs', async () => {
    const stats = reader()
    const screen = await render(<Stage ambient running={0} stats={stats} />)
    await expect.poll(() => stats.read?.().frames ?? 0).toBeGreaterThan(1)
    const before = stats.read!().frames
    await pause(600)
    expect(stats.read!().frames).toBeGreaterThan(before + 5)
    expect(stats.read!().idle).toBe(false)
    expect(drawn(screen.container.querySelector('canvas')!, WHOLE)).toBeGreaterThan(0)
  })

  it('comes to rest on its frame when nothing runs, and moves again when something does', { timeout: 20_000 }, async () => {
    const stats = reader()
    const screen = await render(<Stage running={0} stats={stats} />)
    await expect.poll(() => stats.read?.().frames ?? 0).toBeGreaterThan(1)
    expect(stats.read!().idle).toBe(false)
    await expect.poll(() => stats.read!().idle, { timeout: IDLE_AFTER + 3000 }).toBe(true)
    expect(stats.read!().armed).toBe(false)
    const rested = stats.read!().frames
    await pause(300)
    expect(stats.read!().frames).toBe(rested)
    expect(drawn(screen.container.querySelector('canvas')!, WHOLE)).toBeGreaterThan(0)
    await screen.rerender(<Stage running={1} stats={stats} />)
    await expect.poll(() => stats.read!().frames).toBeGreaterThan(rested + 2)
    expect(stats.read!().idle).toBe(false)
  })

  it('never draws under a security surface, and keeps clear of words set straight on the canvas', async () => {
    for (const mark of [{ secure: true }, { clear: true }]) {
      const stats = reader()
      // 点阵 covers the whole stage, so an undrawn region is a hole, not a gap between particles.
      const screen = await render(<Stage kind="grid" {...mark} stats={stats} />)
      const canvas = screen.container.querySelector('canvas')!
      await expect.poll(() => drawn(canvas, CORNER)).toBeGreaterThan(0)
      await expect.poll(() => drawn(canvas, CARD)).toBe(0)
      // Still so many frames later.
      const frames = stats.read!().frames
      await expect.poll(() => stats.read!().frames).toBeGreaterThan(frames + 2)
      expect(drawn(canvas, CARD)).toBe(0)
      await screen.unmount()
    }
  })

  const fieldHoles = [
    { placement: 'across a narrow surface', hole: { left: 56, top: 95, width: 7, height: 32 } },
    { placement: 'across the corner of a surface', hole: { left: 56, top: 111, width: 11, height: 20 } },
  ]
  it.for(fieldHoles)('cuts a field link $placement out of the stopped frame', async ({ hole }) => {
    document.documentElement.dataset.capture = 'still'
    const stats = reader()
    const screen = await render(<Stage stats={stats} />)
    const canvas = screen.container.querySelector('canvas')!
    // Each box overlaps the middle of a link in the seeded frame, away from the dots at its ends.
    await expect.poll(() => drawn(canvas, hole)).toBeGreaterThan(0)
    const frames = stats.read!().frames
    surface(screen.getByTestId('host').element(), hole)
    await expect.poll(() => stats.read!().frames).toBeGreaterThan(frames)
    expect(drawn(canvas, hole)).toBe(0)
    expect(drawn(canvas, WHOLE)).toBeGreaterThan(0)
    expect(stats.read!().armed).toBe(false)
  })

  it('leaves a marked text surface and the input clear in a focused field', async () => {
    document.documentElement.dataset.capture = 'still'
    const stats = reader()
    const screen = await render(<Stage stats={stats} focus />)
    const canvas = screen.container.querySelector('canvas')!
    const text = { left: 116, top: 210, width: 70, height: 64 }
    await expect.poll(() => drawn(canvas, text)).toBeGreaterThan(0)
    const frames = stats.read!().frames
    surface(screen.getByTestId('host').element(), text, 'data-backdrop-clear')
    await expect.poll(() => stats.read!().frames).toBeGreaterThan(frames)
    expect(drawn(canvas, text)).toBe(0)
    expect(drawn(canvas, CARD)).toBe(0)
    expect(drawn(canvas, WHOLE)).toBeGreaterThan(0)
    expect(stats.read!().armed).toBe(false)
  })

  it('keeps a security surface clear of the soft light and of a focused field too', async () => {
    for (const props of [{ kind: 'glow' as const }, { kind: 'grid' as const, focus: true }]) {
      const stats = reader()
      const screen = await render(<Stage {...props} secure stats={stats} />)
      const canvas = screen.container.querySelector('canvas')!
      await expect.poll(() => drawn(canvas, WHOLE)).toBeGreaterThan(0)
      await expect.poll(() => drawn(canvas, CARD)).toBe(0)
      await screen.unmount()
    }
  })

  it('cuts out a security surface that appears later, and draws there again when it leaves', async () => {
    const stats = reader()
    const screen = await render(<Stage kind="grid" stats={stats} />)
    const canvas = screen.container.querySelector('canvas')!
    const late = { left: 10, top: 180, width: 90, height: 90 }
    await expect.poll(() => drawn(canvas, late)).toBeGreaterThan(0)
    const element = surface(screen.getByTestId('host').element(), late)
    await expect.poll(() => drawn(canvas, late)).toBe(0)
    // Marked later instead of added: the same.
    const card = screen.getByTestId('card').element()
    await expect.poll(() => drawn(canvas, CARD)).toBeGreaterThan(0)
    card.setAttribute('data-secure', '')
    await expect.poll(() => drawn(canvas, CARD)).toBe(0)
    element.remove()
    await expect.poll(() => drawn(canvas, late)).toBeGreaterThan(0)
  })

  it('follows a security surface that scrolls and one that changes size', async () => {
    const stats = reader()
    const screen = await render(
      <Stage kind="grid" stats={stats}>
        <div data-testid="scroller" style={{ position: 'absolute', left: 0, top: 0, width: 110, height: 300, overflow: 'auto' }}>
          <div style={{ height: 900, position: 'relative' }}>
            <div data-secure="" data-testid="moving" style={{ position: 'absolute', left: 10, top: 20, width: 80, height: 60 }} />
          </div>
        </div>
      </Stage>,
    )
    const canvas = screen.container.querySelector('canvas')!
    const top = { left: 10, top: 20, width: 80, height: 60 }
    const lower = { left: 10, top: 200, width: 80, height: 60 }
    await expect.poll(() => drawn(canvas, lower)).toBeGreaterThan(0)
    await expect.poll(() => drawn(canvas, top)).toBe(0)
    // Scrolled by 120: the surface is gone from where it was, and nothing is drawn where it is now.
    const moving = screen.getByTestId('moving').element() as HTMLElement
    moving.style.top = '320px'
    screen.getByTestId('scroller').element().scrollTop = 120
    await expect.poll(() => drawn(canvas, lower)).toBe(0)
    await expect.poll(() => drawn(canvas, top)).toBeGreaterThan(0)
    // It grows: the hole grows with it.
    const grown = { left: 10, top: 262, width: 80, height: 30 }
    await expect.poll(() => drawn(canvas, grown)).toBeGreaterThan(0)
    moving.style.height = '95px'
    await expect.poll(() => drawn(canvas, grown)).toBe(0)
  })

  it('cuts a security surface that arrives during a stream out of the still frame', async () => {
    const stats = reader()
    const screen = await render(<Stage kind="grid" stats={stats} />)
    const canvas = screen.container.querySelector('canvas')!
    const late = { left: 300, top: 10, width: 90, height: 90 }
    await expect.poll(() => drawn(canvas, late)).toBeGreaterThan(0)
    const unmark = markStreaming(screen.getByTestId('card').element())
    try {
      await expect.poll(() => stats.read!().paused).toEqual(['streaming'])
      surface(screen.getByTestId('host').element(), late)
      await expect.poll(() => drawn(canvas, late)).toBe(0)
      expect(stats.read!().paused).toEqual(['streaming'])
      expect(stats.read!().armed).toBe(false)
    } finally {
      unmark()
    }
  })

  it('places its holes rightly under a scaled ancestor', async () => {
    const stats = reader()
    const screen = await render(
      <div style={{ transform: 'scale(0.5)', transformOrigin: '0 0', width: 400, height: 300 }}>
        <Stage kind="grid" secure stats={stats} />
      </div>,
    )
    const canvas = screen.container.querySelector('canvas')!
    // On screen the stage is half its size; the canvas still draws its own 400 × 300.
    expect(Math.round(canvas.getBoundingClientRect().width)).toBe(200)
    expect(canvas.clientWidth).toBe(400)
    await expect.poll(() => drawn(canvas, CORNER)).toBeGreaterThan(0)
    await expect.poll(() => drawn(canvas, CARD)).toBe(0)
    // Where the card would be if the scale were ignored (its on-screen box) is drawn outside the real hole's feather.
    expect(drawn(canvas, { left: 0, top: 0, width: 50, height: 40 })).toBeGreaterThan(0)
    expect(drawn(canvas, { left: 340, top: 230, width: 60, height: 70 })).toBeGreaterThan(0)
  })

  it('is not rendered inside a security surface at all', async () => {
    const stats = reader()
    const screen = await render(
      <div data-secure="">
        <Stage stats={stats} />
      </div>,
    )
    expect(getComputedStyle(screen.container.querySelector('canvas')!).display).toBe('none')
    await pause(120)
    expect(stats.read).toBeNull()
  })

  it('holds one still frame while a reply streams in view, and moves again when it ends', async () => {
    const stats = reader()
    const screen = await render(<Stage stats={stats} />)
    const canvas = screen.container.querySelector('canvas')!
    await expect.poll(() => stats.read?.().frames ?? 0).toBeGreaterThan(1)
    const unmark = markStreaming(screen.getByTestId('card').element())
    await expect.poll(() => stats.read!().paused).toEqual(['streaming'])
    const held = stats.read!().frames
    await pause(250)
    expect(stats.read!().frames).toBe(held)
    expect(drawn(canvas, WHOLE)).toBeGreaterThan(0)
    unmark()
    expect(stats.read!().paused).toEqual([])
    await expect.poll(() => stats.read!().frames).toBeGreaterThan(held)
  })

  it('holds one still frame while the tab is hidden or the window is in the background', async () => {
    const stats = reader()
    await render(<Stage stats={stats} />)
    await expect.poll(() => stats.read?.().frames ?? 0).toBeGreaterThan(1)
    const visibility = (state: 'hidden' | 'visible') => {
      Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
    }
    try {
      visibility('hidden')
      expect(stats.read!().paused).toEqual(['hidden'])
      const held = stats.read!().frames
      await pause(200)
      expect(stats.read!().frames).toBe(held)
    } finally {
      visibility('visible')
      delete (document as { visibilityState?: unknown }).visibilityState
    }
    expect(stats.read!().paused).toEqual([])
    window.dispatchEvent(new Event('blur'))
    expect(stats.read!().paused).toEqual(['blur'])
    expect(stats.read!().armed).toBe(false)
    window.dispatchEvent(new Event('focus'))
    expect(stats.read!().paused).toEqual([])
  })

  it('starts paused when it mounts in a visible window that already lost focus', async () => {
    const focused = vi.mocked(document.hasFocus)
    focused.mockReturnValue(false)
    const stats = reader()
    await render(<Stage running={1} stats={stats} />)
    expect(stats.read!().paused).toEqual(['blur'])
    expect(stats.read!().armed).toBe(false)

    focused.mockReturnValue(true)
    window.dispatchEvent(new Event('focus'))
    expect(stats.read!().paused).toEqual([])
    const held = stats.read!().frames
    await expect.poll(() => stats.read!().frames).toBeGreaterThan(held)
  })

  it('draws one still frame with reduced motion, the same frame every time', async () => {
    await emulateMedia({ 'prefers-reduced-motion': 'reduce' }, async () => {
      const frames: string[] = []
      for (let pass = 0; pass < 2; pass++) {
        const stats = reader()
        const screen = await render(<Stage stats={stats} />)
        const canvas = screen.container.querySelector('canvas')!
        await expect.poll(() => stats.read?.().paused ?? []).toEqual(['reduced'])
        await expect.poll(() => drawn(canvas, WHOLE)).toBeGreaterThan(0)
        const held = stats.read!().frames
        await pause(200)
        expect(stats.read!().frames).toBe(held)
        expect(stats.read!().armed).toBe(false)
        frames.push(canvas.toDataURL())
        await screen.unmount()
      }
      // The field is seeded, not random: two mounts hold the identical frame.
      expect(frames[1]).toBe(frames[0])
    })
  })

  it('holds the same still frame for a capture after the layer shrank and grew back', async () => {
    document.documentElement.dataset.capture = 'still'
    const stats = reader()
    const screen = await render(<Stage stats={stats} />)
    const canvas = screen.container.querySelector('canvas')!
    await expect.poll(() => stats.read?.().paused ?? []).toContain('capture')
    await expect.poll(() => drawn(canvas, WHOLE)).toBeGreaterThan(0)
    const first = canvas.toDataURL()
    await screen.rerender(<Stage stats={stats} style={{ width: 160, height: 120 }} />)
    await expect.poll(() => canvas.clientWidth).toBe(160)
    await pause(100)
    await screen.rerender(<Stage stats={stats} />)
    await expect.poll(() => canvas.clientWidth).toBe(400)
    // The particles seeded again for the larger area are the ones it had, not the next of one running sequence.
    await expect.poll(() => canvas.toDataURL()).toBe(first)
  })

  it.each(['#2c426e', '#cedaee'])('draws the frozen backdrop with a compiled hex ink %s', async ink => {
    document.documentElement.dataset.capture = 'still'
    const stats = reader()
    const screen = await render(<Stage stats={stats} style={{ '--fx-ink': ink } as CSSProperties} />)
    const canvas = screen.container.querySelector('canvas')!
    expect(getComputedStyle(canvas).getPropertyValue('--fx-ink')).toBe(ink)
    await expect.poll(() => stats.read?.().paused ?? []).toContain('capture')
    await expect.poll(() => drawn(canvas, WHOLE)).toBeGreaterThan(0)
    expect(stats.read!().armed).toBe(false)
  })

  it('holds still for 减弱 on this device and for a page frozen for a capture, each by its own attribute', async () => {
    const stats = reader()
    await render(<Stage stats={stats} />)
    await expect.poll(() => stats.read?.().frames ?? 0).toBeGreaterThan(1)
    const root = document.documentElement
    root.dataset.motion = 'reduce'
    await expect.poll(() => stats.read!().paused).toEqual(['reduced'])
    root.dataset.capture = 'still'
    await expect.poll(() => stats.read!().paused.toSorted()).toEqual(['capture', 'reduced'])
    // The setting going back to 跟随系统 does not unfreeze the capture.
    delete root.dataset.motion
    await expect.poll(() => stats.read!().paused).toEqual(['capture'])
    delete root.dataset.capture
    await expect.poll(() => stats.read!().paused).toEqual([])
  })

  it('holds still on a low battery, and on a phone that does not report its battery', async () => {
    const source = navigator as Navigator & { getBattery?: () => Promise<unknown> }
    const original = source.getBattery
    const battery = Object.assign(new EventTarget(), { charging: false, level: 0.15 })
    source.getBattery = () => Promise.resolve(battery)
    try {
      const stats = reader()
      const screen = await render(<Stage stats={stats} />)
      await expect.poll(() => stats.read?.().paused ?? []).toEqual(['power'])
      battery.charging = true
      battery.dispatchEvent(new Event('chargingchange'))
      expect(stats.read!().paused).toEqual([])
      await screen.unmount()
      // No report: a desktop keeps moving, a phone holds its frame.
      Object.defineProperty(source, 'getBattery', { value: undefined, configurable: true, writable: true })
      const silent = reader()
      const desktop = await render(<Stage stats={silent} />)
      await expect.poll(() => silent.read?.().frames ?? 0).toBeGreaterThan(1)
      expect(silent.read!().paused).toEqual([])
      await desktop.unmount()
      await page.viewport(390, 844)
      const phone = reader()
      const small = await render(<Stage stats={phone} style={{ width: 300 }} />)
      await expect.poll(() => phone.read?.().paused ?? []).toEqual(['power'])
      await expect
        .poll(() => drawn(small.container.querySelector('canvas')!, { left: 0, top: 0, width: 300, height: 300 }))
        .toBeGreaterThan(0)
      expect(phone.read!().armed).toBe(false)
    } finally {
      await page.viewport(1280, 800)
      if (original) source.getBattery = original
      else delete source.getBattery
    }
  })

  it('gathers round the focused input and leaves the input itself clear', async () => {
    const stats = reader()
    const screen = await render(<Stage kind="grid" focus stats={stats} />)
    const canvas = screen.container.querySelector('canvas')!
    await expect.poll(() => drawn(canvas, CORNER)).toBeGreaterThan(0)
    await expect.poll(() => drawn(canvas, CARD)).toBe(0)
  })

  it('takes a resolved decision as one ring that widens and ends; the same id is no new ring, and a paused layer takes none', async () => {
    const stats = reader()
    const screen = await render(<Stage stats={stats} />)
    await expect.poll(() => stats.read?.().frames ?? 0).toBeGreaterThan(1)
    expect(stats.read!().rings).toBe(0)
    const host = screen.getByTestId('host').element().getBoundingClientRect()
    const at = { x: host.left + 200, y: host.top + 150 }
    await screen.rerender(<Stage stats={stats} resolved={{ id: 1, ...at }} />)
    expect(stats.read!().rings).toBe(1)
    // Rendered again with the same decision: still one ring.
    await screen.rerender(<Stage stats={stats} running={3} resolved={{ id: 1, ...at }} />)
    expect(stats.read!().rings).toBe(1)
    await screen.rerender(<Stage stats={stats} running={3} resolved={{ id: 2, ...at }} />)
    expect(stats.read!().rings).toBe(2)
    // Each ring is over in under a second.
    await expect.poll(() => stats.read!().rings, { timeout: 3000 }).toBe(0)
    document.documentElement.dataset.motion = 'reduce'
    await expect.poll(() => stats.read!().paused).toEqual(['reduced'])
    await screen.rerender(<Stage stats={stats} running={3} resolved={{ id: 3, ...at }} />)
    expect(stats.read!().rings).toBe(0)
  })

  it('leaves nothing behind when it unmounts: no timer, no frame, no listener, no observer callback', async () => {
    const targets = [window, document] as const
    const live = new Map<string, number>()
    const originals = targets.map(target => [target.addEventListener, target.removeEventListener] as const)
    targets.forEach((target, index) => {
      const name = index === 0 ? 'window' : 'document'
      target.addEventListener = ((type: string, ...rest: unknown[]) => {
        live.set(`${name} ${type}`, (live.get(`${name} ${type}`) ?? 0) + 1)
        return (originals[index]![0] as (...args: unknown[]) => void).call(target, type, ...rest)
      }) as typeof target.addEventListener
      target.removeEventListener = ((type: string, ...rest: unknown[]) => {
        live.set(`${name} ${type}`, (live.get(`${name} ${type}`) ?? 0) - 1)
        return (originals[index]![1] as (...args: unknown[]) => void).call(target, type, ...rest)
      }) as typeof target.removeEventListener
    })
    try {
      const stats = reader()
      const screen = await render(<Stage kind="grid" secure stats={stats} />)
      await expect.poll(() => stats.read?.().frames ?? 0).toBeGreaterThan(1)
      const read = stats.read!
      expect([...live.values()].some(count => count > 0)).toBe(true)
      await screen.unmount()
      expect(stats.read).toBeNull()
      expect(read().armed).toBe(false)
      const frames = read().frames
      // Whatever the page does next reaches a layer that is gone: nothing draws.
      surface(document.body, { left: 0, top: 0, width: 10, height: 10 }).remove()
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('focus'))
      await pause(200)
      expect(read().frames).toBe(frames)
      expect([...live].filter(([, count]) => count !== 0)).toEqual([])
    } finally {
      targets.forEach((target, index) => {
        target.addEventListener = originals[index]![0]
        target.removeEventListener = originals[index]![1]
      })
    }
  })
})

function centre(element: Element): [number, number] {
  const box = element.getBoundingClientRect()
  return [box.left + box.width / 2, box.top + box.height / 2]
}
function corner(element: Element): [number, number] {
  const box = element.getBoundingClientRect()
  return [box.left + 4, box.top + 4]
}
