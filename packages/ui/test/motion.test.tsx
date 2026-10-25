import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { commands } from 'vitest/browser'
import { Check, Copy } from 'lucide-react'
import { Collapse, IconButton, MOTION, Shimmer, Swap, usePresence } from '../src/index.ts'
import { protocol } from './helpers.ts'

const frames = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
const pause = (ms: number) => new Promise(done => setTimeout(done, ms))
/** The first CSS animation running on an element. */
const cssAnimation = (element: Element) => element.getAnimations().find((item): item is CSSAnimation => item instanceof CSSAnimation)

function Disclosure({ initial = false, onReveal }: { initial?: boolean; onReveal?: () => void }) {
  const [open, setOpen] = useState(initial)
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setOpen(!open)
        }}>
        toggle
      </button>
      <Collapse
        open={open}
        onReveal={() => {
          onReveal?.()
          setOpen(true)
        }}>
        <p>Body text that the browser&apos;s find can reach</p>
      </Collapse>
    </div>
  )
}

function Leaving({ show }: { show: boolean }) {
  const { present, leaving } = usePresence(show, MOTION.fastExit)
  return <div>{present && <span data-leaving={leaving ? '' : undefined}>pill</span>}</div>
}

/** A copy button whose icon turns into a check once pressed. */
function Copying() {
  const [copied, setCopied] = useState(false)
  return (
    <IconButton
      label="复制"
      icon={copied ? Check : Copy}
      swap
      onClick={() => {
        setCopied(true)
      }}
    />
  )
}

describe('motion tokens', () => {
  it('gives scripts the same durations as the stylesheet', async () => {
    const tokens = (await commands.readFile('packages/ui/src/tokens.css')).replace(/\/\*[\s\S]*?\*\//gu, '')
    const value = (name: string) => {
      const match = new RegExp(`${name}:\\s*([\\d.]+)(ms|s);`, 'u').exec(tokens)
      if (!match) throw new Error(`${name} is not in tokens.css`)
      return Number(match[1]) * (match[2] === 's' ? 1000 : 1)
    }
    expect({
      fast: value('--d-fast'),
      base: value('--d-base'),
      slow: value('--d-slow'),
      fastExit: value('--d-fast-exit'),
      baseExit: value('--d-base-exit'),
      slowExit: value('--d-slow-exit'),
      stagger: value('--d-stagger'),
      shimmer: value('--d-shimmer'),
      hint: value('--delay-hint'),
    }).toEqual(MOTION)
  })
})

describe('disclosures', () => {
  it('grows downward through its grid row on the entry curve and closes on the exit curve, staying in the page', async () => {
    const screen = await render(<Disclosure />)
    const box = screen.container.querySelector<HTMLElement>('.ui-collapse')!
    const inner = box.querySelector<HTMLElement>('.ui-collapse-inner')!
    // Closed: out of the focus order and the accessibility tree, but there for the browser's find.
    expect(box.dataset.state).toBe('closed')
    expect(inner.getAttribute('hidden')).toBe('until-found')
    expect(inner.textContent).toContain('Body text')
    await screen.getByRole('button', { name: 'toggle' }).click()
    expect(box.dataset.state).toBe('open')
    expect(inner.hasAttribute('hidden')).toBe(false)
    const opening = getComputedStyle(box)
    expect(opening.transitionProperty).toBe('grid-template-rows')
    expect(opening.transitionDuration).toBe(`${MOTION.base / 1000}s`)
    expect(opening.transitionTimingFunction).toBe('cubic-bezier(0.2, 0, 0, 1)')
    expect(getComputedStyle(inner).transitionDelay).toBe(`${MOTION.stagger / 1000}s`)
    await expect.poll(() => box.hasAttribute('data-settled'), { timeout: 2000 }).toBe(true)

    await screen.getByRole('button', { name: 'toggle' }).click()
    expect(box.dataset.state).toBe('closing')
    // Closing, the body is inert; once closed it is hidden until found.
    expect(inner.inert).toBe(true)
    const closing = getComputedStyle(box)
    expect(closing.transitionDuration).toBe(`${MOTION.baseExit / 1000}s`)
    expect(closing.transitionTimingFunction).toBe('cubic-bezier(0.4, 0, 1, 1)')
    await expect.poll(() => box.dataset.state, { timeout: 2000 }).toBe('closed')
    expect(inner.inert).toBe(false)
    expect(inner.getAttribute('hidden')).toBe('until-found')
  })

  it('opens when the browser finds text inside it', async () => {
    let revealed = 0
    const screen = await render(
      <Disclosure
        onReveal={() => {
          revealed++
        }}
      />,
    )
    const inner = screen.container.querySelector<HTMLElement>('.ui-collapse-inner')!
    inner.dispatchEvent(new Event('beforematch'))
    await expect.poll(() => screen.container.querySelector<HTMLElement>('.ui-collapse')?.dataset.state).toBe('open')
    expect(revealed).toBe(1)
  })

  it('shows an open body at once on its first render and renders a lazy body only once it opens', async () => {
    const screen = await render(<Disclosure initial />)
    const box = screen.container.querySelector<HTMLElement>('.ui-collapse')!
    expect(box.dataset.state).toBe('open')
    expect(box.hasAttribute('data-settled')).toBe(true)
    const lazy = await render(
      <Collapse open={false} lazy>
        <p>heavy</p>
      </Collapse>,
    )
    expect(lazy.container.textContent).not.toContain('heavy')
  })
})

describe('swaps and presence', () => {
  it('swaps a copy icon for a check that scales in, but not on the first render', async () => {
    const screen = await render(<Copying />)
    const swap = () => screen.container.querySelector<HTMLElement>('.ui-swap')!
    expect(swap().hasAttribute('data-swapped')).toBe(false)
    expect(swap().getAnimations()).toHaveLength(0)
    await screen.getByRole('button', { name: '复制' }).click()
    await expect.poll(() => swap().hasAttribute('data-swapped')).toBe(true)
    const animation = cssAnimation(swap())
    expect(animation?.animationName).toBe('ui-swap-in')
    expect(animation?.effect?.getTiming().duration).toBe(MOTION.fast)
  })

  it('cross-fades words in place without scaling them', async () => {
    const screen = await render(
      <Swap value="live" effect="fade">
        正在思考
      </Swap>,
    )
    await screen.rerender(
      <Swap value="settled" effect="fade">
        思考了 6 秒
      </Swap>,
    )
    const swap = screen.container.querySelector<HTMLElement>('.ui-swap')!
    expect(cssAnimation(swap)?.animationName).toBe('ui-swap-fade')
  })

  it('keeps what leaves on screen for its exit, marked as leaving', async () => {
    const screen = await render(<Leaving show />)
    expect(screen.container.querySelector('[data-leaving]')).toBeNull()
    await screen.rerender(<Leaving show={false} />)
    expect(screen.container.querySelector('[data-leaving]')).not.toBeNull()
    await expect.poll(() => screen.container.textContent).toBe('')
  })
})

describe('the live label', () => {
  it('moves only the light behind its words, once every 1.6s, and stands still under reduced motion', async () => {
    const screen = await render(<Shimmer>正在思考</Shimmer>)
    const label = screen.container.querySelector<HTMLElement>('.ui-shimmer')!
    await frames()
    const moving = cssAnimation(label)
    expect(moving?.animationName).toBe('ui-shimmer')
    expect(moving?.effect?.getTiming().duration).toBe(MOTION.shimmer)
    const keyframes = moving?.effect instanceof KeyframeEffect ? moving.effect.getKeyframes() : []
    expect(
      new Set(
        keyframes.flatMap(frame => Object.keys(frame).filter(key => !['offset', 'computedOffset', 'easing', 'composite'].includes(key))),
      ),
    ).toEqual(new Set(['backgroundPositionX', 'backgroundPositionY']))
    await protocol().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    try {
      await pause(50)
      expect(label.getAnimations()).toHaveLength(0)
      expect(getComputedStyle(label).color).not.toBe('rgba(0, 0, 0, 0)')
    } finally {
      await protocol().send('Emulation.setEmulatedMedia', { features: [] })
    }
  })
})
