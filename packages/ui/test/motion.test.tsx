import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { commands } from 'vitest/browser'
import { Check, Copy } from 'lucide-react'
import { Collapse, EASING, IconButton, MOTION, Shimmer, Swap, switchTheme, usePresence } from '../src/index.ts'
import { protocol } from './helpers.ts'

const frames = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
const pause = (ms: number) => new Promise(done => setTimeout(done, ms))
/** The first CSS animation running on an element. */
const cssAnimation = (element: Element) => element.getAnimations().find((item): item is CSSAnimation => item instanceof CSSAnimation)
/** Emulates `prefers-reduced-motion: reduce` for the duration of `run`. */
async function reducedMotion(run: () => Promise<void>): Promise<void> {
  await protocol().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  try {
    await run()
  } finally {
    await protocol().send('Emulation.setEmulatedMedia', { features: [] })
  }
}

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
  const { present, leaving } = usePresence(show, MOTION.microExit)
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
  it('gives scripts the durations and curves of the stylesheet, each exit at 70% of its entrance', async () => {
    const tokens = (await commands.readFile('packages/ui/src/tokens.css')).replace(/\/\*[\s\S]*?\*\//gu, '')
    const value = (name: string) => {
      const match = new RegExp(`${name}:\\s*([\\d.]+)(ms|s);`, 'u').exec(tokens)
      if (!match) throw new Error(`${name} is not in tokens.css`)
      return Number(match[1]) * (match[2] === 's' ? 1000 : 1)
    }
    const curve = (name: string) => new RegExp(`${name}:\\s*(cubic-bezier\\([^)]*\\));`, 'u').exec(tokens)?.[1]
    const durations = {
      micro: value('--m-micro'),
      enter: value('--m-enter'),
      panel: value('--m-panel'),
      sheet: value('--m-sheet'),
      push: value('--m-push'),
    }
    const exits = Object.fromEntries(Object.entries(durations).map(([name, ms]) => [`${name}Exit`, Math.round(ms * 0.7)]))
    expect({ ...durations, ...exits }).toEqual(MOTION)
    expect({
      micro: curve('--e-micro'),
      enter: curve('--e-enter'),
      panel: curve('--e-panel'),
      sheet: curve('--e-sheet'),
      push: curve('--e-push'),
      exit: curve('--e-exit'),
    }).toEqual(EASING)
  })

  it('resolves to the same values on the page', () => {
    const probe = document.createElement('div')
    document.body.append(probe)
    try {
      const read = (duration: string, easing: string) => {
        probe.style.transition = `opacity ${duration} var(${easing})`
        const style = getComputedStyle(probe)
        return [style.transitionDuration, style.transitionTimingFunction]
      }
      expect([
        read('var(--m-micro)', '--e-micro'),
        read('var(--m-enter)', '--e-enter'),
        read('var(--m-panel)', '--e-panel'),
        read('var(--m-sheet)', '--e-sheet'),
        read('var(--m-push)', '--e-push'),
        read('calc(var(--m-sheet) * 0.7)', '--e-exit'),
      ]).toEqual([
        ['0.12s', EASING.micro],
        ['0.16s', EASING.enter],
        ['0.2s', EASING.panel],
        ['0.26s', EASING.sheet],
        ['0.32s', EASING.push],
        ['0.182s', EASING.exit],
      ])
    } finally {
      probe.remove()
    }
  })

  it('shortens every duration to 120ms or less under reduced motion', async () => {
    await reducedMotion(async () => {
      await pause(20)
      const root = getComputedStyle(document.documentElement)
      const durations = ['--m-micro', '--m-enter', '--m-panel', '--m-sheet', '--m-push'].map(name =>
        parseFloat(root.getPropertyValue(name)),
      )
      expect(durations.every(ms => ms <= 120)).toBe(true)
    })
  })

  it('switches a theme without transitions, and lets them back on two frames later', async () => {
    const button = document.createElement('button')
    button.className = 'ui-button'
    button.dataset.variant = 'secondary'
    document.body.append(button)
    const previous = document.documentElement.dataset.theme
    try {
      switchTheme(() => {
        document.documentElement.dataset.theme = 'dark'
      })
      expect(document.documentElement.hasAttribute('data-theme-switching')).toBe(true)
      expect(
        getComputedStyle(button)
          .transitionDuration.split(', ')
          .every(value => value === '0s'),
      ).toBe(true)
      expect(button.getAnimations()).toHaveLength(0)
      await frames()
      await frames()
      expect(document.documentElement.hasAttribute('data-theme-switching')).toBe(false)
      expect(getComputedStyle(button).transitionDuration).toContain('0.12s')
    } finally {
      button.remove()
      if (previous === undefined) delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = previous
    }
  })
})

describe('disclosures', () => {
  it('grows downward through its grid row over --m-panel and closes in 70% of it on the exit curve, staying in the page', async () => {
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
    expect([opening.transitionProperty, opening.transitionDuration, opening.transitionTimingFunction]).toEqual([
      'grid-template-rows',
      `${MOTION.panel / 1000}s`,
      EASING.panel,
    ])
    // The content fades in with the box, not after it.
    expect([getComputedStyle(inner).transitionDuration, getComputedStyle(inner).transitionDelay]).toEqual([`${MOTION.panel / 1000}s`, '0s'])
    await expect.poll(() => box.hasAttribute('data-settled'), { timeout: 2000 }).toBe(true)

    await screen.getByRole('button', { name: 'toggle' }).click()
    expect(box.dataset.state).toBe('closing')
    // Closing, the body is inert; once closed it is hidden until found.
    expect(inner.inert).toBe(true)
    const closing = getComputedStyle(box)
    expect([closing.transitionDuration, closing.transitionTimingFunction]).toEqual([`${MOTION.panelExit / 1000}s`, EASING.exit])
    await expect.poll(() => box.dataset.state, { timeout: 2000 }).toBe('closed')
    expect(inner.inert).toBe(false)
    expect(inner.getAttribute('hidden')).toBe('until-found')
  })

  it('only fades under reduced motion: the box opens at once', async () => {
    await reducedMotion(async () => {
      const screen = await render(<Disclosure />)
      await screen.getByRole('button', { name: 'toggle' }).click()
      const box = screen.container.querySelector<HTMLElement>('.ui-collapse')!
      expect(getComputedStyle(box).transitionProperty).not.toContain('grid-template-rows')
      const inner = getComputedStyle(box.querySelector('.ui-collapse-inner')!)
      expect(inner.transitionProperty).toContain('opacity')
      expect(parseFloat(inner.transitionDuration)).toBeLessThanOrEqual(0.12)
    })
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

  it('shows an open body at once on its first render, as a restored page does, and renders a lazy body only once it opens', async () => {
    const screen = await render(<Disclosure initial />)
    const box = screen.container.querySelector<HTMLElement>('.ui-collapse')!
    expect(box.dataset.state).toBe('open')
    expect(box.hasAttribute('data-settled')).toBe(true)
    expect(box.getAnimations({ subtree: true })).toHaveLength(0)
    const lazy = await render(
      <Collapse open={false} lazy>
        <p>heavy</p>
      </Collapse>,
    )
    expect(lazy.container.textContent).not.toContain('heavy')
  })
})

describe('swaps and presence', () => {
  it('swaps a copy icon for a check that scales in over --m-micro, but not on the first render', async () => {
    const screen = await render(<Copying />)
    const swap = () => screen.container.querySelector<HTMLElement>('.ui-swap')!
    expect(swap().hasAttribute('data-swapped')).toBe(false)
    expect(swap().getAnimations()).toHaveLength(0)
    await screen.getByRole('button', { name: '复制' }).click()
    await expect.poll(() => swap().hasAttribute('data-swapped')).toBe(true)
    const animation = cssAnimation(swap())
    expect(animation?.animationName).toBe('ui-swap-in')
    expect(animation?.effect?.getTiming().duration).toBe(MOTION.micro)
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
    expect(cssAnimation(swap)?.animationName).toBe('ui-fade-in')
  })

  it('keeps what leaves on screen for its exit, marked as leaving', async () => {
    const screen = await render(<Leaving show />)
    expect(screen.container.querySelector('[data-leaving]')).toBeNull()
    await screen.rerender(<Leaving show={false} />)
    expect(screen.container.querySelector('[data-leaving]')).not.toBeNull()
    await expect.poll(() => screen.container.textContent).toBe('')
  })
})

describe('the thinking shimmer', () => {
  it('waits 600ms, then sweeps the light behind its words once over 1s of every 4s', async () => {
    const screen = await render(<Shimmer>正在思考</Shimmer>)
    const label = screen.container.querySelector<HTMLElement>('.ui-shimmer')!
    await frames()
    const moving = cssAnimation(label)
    expect(moving?.animationName).toBe('ui-think')
    const timing = moving?.effect?.getTiming()
    expect([timing?.duration, timing?.delay, timing?.iterations]).toEqual([4000, 600, Infinity])
    const keyframes = moving?.effect instanceof KeyframeEffect ? moving.effect.getKeyframes() : []
    // Only the gradient behind the text moves, and the sweep is the first quarter of the cycle: 1s.
    expect(
      new Set(
        keyframes.flatMap(frame => Object.keys(frame).filter(key => !['offset', 'computedOffset', 'easing', 'composite'].includes(key))),
      ),
    ).toEqual(new Set(['backgroundPositionX', 'backgroundPositionY']))
    expect(keyframes.map(frame => frame.computedOffset)).toContain(0.25)
  })

  it('pauses while it is out of view and goes on when it comes back', async () => {
    const screen = await render(
      <div style={{ height: 120, overflow: 'auto' }} data-testid="scroller">
        <div style={{ height: 600 }} />
        <Shimmer>正在思考</Shimmer>
      </div>,
    )
    const label = screen.container.querySelector<HTMLElement>('.ui-shimmer')!
    await expect.poll(() => label.hasAttribute('data-offscreen')).toBe(true)
    await expect.poll(() => cssAnimation(label)?.playState).toBe('paused')
    screen.getByTestId('scroller').element().scrollTop = 600
    await expect.poll(() => label.hasAttribute('data-offscreen')).toBe(false)
    await expect.poll(() => cssAnimation(label)?.playState).toBe('running')
  })

  it('stands still under reduced motion, as plain words in muted ink', async () => {
    const screen = await render(<Shimmer>正在思考</Shimmer>)
    const label = screen.container.querySelector<HTMLElement>('.ui-shimmer')!
    await reducedMotion(async () => {
      await pause(50)
      expect(label.getAnimations()).toHaveLength(0)
      expect(getComputedStyle(label).backgroundImage).toBe('none')
      expect(getComputedStyle(label).color).toBe('rgb(113, 113, 122)')
    })
  })
})
