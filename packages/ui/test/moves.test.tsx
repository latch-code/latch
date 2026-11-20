import { useState } from 'react'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import {
  Button,
  EASING,
  LiveChanges,
  LiveDot,
  MOTION,
  PillMove,
  Roll,
  RunningEdge,
  SectionTitle,
  Spinner,
  crossFade,
  enter,
  exit,
  flip,
  markStreaming,
  motionAllowed,
  moveLane,
  moving,
  resolveAndRise,
  sendLift,
  sheenOnce,
  stagger,
  captureStill,
  setReducedMotion,
  streamingInView,
  useLiveChange,
  watchMotion,
} from '../src/index.ts'
import { RISE } from '../src/moves.ts'
import { emulateMedia } from './helpers.ts'

const frames = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
const reduced = (run: () => unknown) => emulateMedia({ 'prefers-reduced-motion': 'reduce' }, run)
/** The moves on an element: the animations moves.ts started. */
const moves = (element: Element) => element.getAnimations().filter(item => item.id === 'ui-move')
const keyframes = (animation: Animation) => (animation.effect as KeyframeEffect).getKeyframes()
/** An easing as the browser writes it back, so a token and a running animation compare whatever their spelling. */
function curve(easing: string | undefined): string {
  const probe = document.createElement('i')
  probe.style.transitionTimingFunction = easing ?? ''
  return probe.style.transitionTimingFunction
}
const timing = (animation: Animation) => {
  const read = (animation.effect as KeyframeEffect).getTiming()
  return { ...read, easing: curve(read.easing) }
}
/** The properties an animation changes: only transform and opacity may move. */
const properties = (animation: Animation) =>
  [...new Set(keyframes(animation).flatMap(frame => Object.keys(frame)))].filter(
    key => !['offset', 'easing', 'composite', 'computedOffset'].includes(key),
  )

function box(text = 'row'): HTMLElement {
  const element = document.createElement('div')
  element.textContent = text
  element.style.cssText = 'width: 120px; height: 24px'
  document.body.append(element)
  return element
}

function list(count: number): { root: HTMLElement; rows: HTMLElement[] } {
  const root = document.createElement('div')
  const rows = Array.from({ length: count }, (_, index) => {
    const row = document.createElement('div')
    row.textContent = `row ${index}`
    row.style.height = '24px'
    root.append(row)
    return row
  })
  document.body.append(root)
  return { root, rows }
}

const made: Element[] = []
const keep = <T extends Element>(element: T): T => {
  made.push(element)
  return element
}
afterEach(() => {
  for (const element of made.splice(0)) element.remove()
  delete document.documentElement.dataset.motion
  delete document.documentElement.dataset.capture
})

describe('row-enter and row-exit', () => {
  it('fades a row in while it rises 4px over 160ms, moving only opacity and transform', () => {
    const row = keep(box())
    // The distance is the token's.
    expect(`${RISE}px`).toBe(getComputedStyle(document.documentElement).getPropertyValue('--rise').trim())
    const animation = enter(row)!
    expect(properties(animation).toSorted()).toEqual(['opacity', 'transform'])
    expect(keyframes(animation).map(frame => [frame.opacity, frame.transform])).toEqual([
      ['0', 'translateY(4px)'],
      ['1', 'none'],
    ])
    expect([timing(animation).duration, timing(animation).easing]).toEqual([MOTION.enter, curve(EASING.enter)])
  })

  it('fades what leaves over 112ms on the exit curve and keeps it hidden until it is taken away', async () => {
    const row = keep(box())
    const left = exit(row)
    const [animation] = moves(row)
    expect([timing(animation!).duration, timing(animation!).easing, timing(animation!).fill]).toEqual([
      MOTION.enterExit,
      curve(EASING.exit),
      'forwards',
    ])
    animation!.finish()
    expect(await left).toBe(true)
    expect(getComputedStyle(row).opacity).toBe('0')
  })

  it('starts an entrance from where an interrupted exit had brought the row, and tells the exit it did not finish', async () => {
    const row = keep(box())
    const left = exit(row)
    moves(row)[0]!.currentTime = MOTION.enterExit / 2
    const back = enter(row)!
    expect(await left).toBe(false)
    expect(moves(row)).toEqual([back])
    const from = keyframes(back)[0]!
    expect(Number(from.opacity)).toBeGreaterThan(0)
    expect(Number(from.opacity)).toBeLessThan(1)
    expect(from.transform).toMatch(/^matrix/u)
  })

  it('only fades, for 120ms or less, with reduced motion', async () => {
    await reduced(async () => {
      const row = keep(box())
      const arriving = enter(row)!
      expect(properties(arriving)).toEqual(['opacity'])
      expect(Number(timing(arriving).duration)).toBeLessThanOrEqual(120)
      const left = exit(row)
      const leaving = moves(row)[0]!
      expect(properties(leaving)).toEqual(['opacity'])
      expect(Number(timing(leaving).duration)).toBeLessThanOrEqual(120)
      leaving.finish()
      await left
    })
  })

  it('brings the pill up 8px on the spring over 420ms', () => {
    const pill = keep(box())
    const animation = enter(pill, { pill: true })!
    expect(keyframes(animation)[0]!.transform).toBe('translateY(8px)')
    expect([timing(animation).duration, timing(animation).easing]).toEqual([MOTION.settle, curve(EASING.spring)])
  })
})

describe('flip, resolve and move-lane', () => {
  it('slides rows from where they were to where they are with one measurement before and one after', () => {
    const { root, rows } = list(3)
    keep(root)
    const animations = flip(rows.slice(1), () => {
      rows[0]!.remove()
    })
    expect(animations).toHaveLength(2)
    expect(keyframes(animations[0]!).map(frame => frame.transform)).toEqual(['translate(0px, 24px)', 'none'])
    expect([timing(animations[0]!).duration, timing(animations[0]!).easing]).toEqual([MOTION.panel, curve(EASING.spring)])
    expect(properties(animations[0]!)).toEqual(['transform'])
  })

  it('starts a second slide from where the first had brought the row', () => {
    const { root, rows } = list(3)
    keep(root)
    const [first] = flip([rows[2]!], () => {
      rows[0]!.remove()
    })
    // A tenth of the way in time: the row has not arrived, so it is still below its place.
    first!.currentTime = MOTION.panel / 10
    const [second] = flip([rows[2]!], () => {
      rows[1]!.remove()
    })
    expect(moves(rows[2]!)).toEqual([second])
    // The new slide covers the 24px of the second gap and what was left of the first.
    const travelled = /translate\(0px, ([\d.]+)px\)/u.exec(String(keyframes(second!)[0]!.transform))
    expect(Number(travelled?.[1])).toBeGreaterThan(24)
    expect(Number(travelled?.[1])).toBeLessThan(48)
  })

  it('just changes the document with reduced motion or above twelve rows', async () => {
    const many = list(14)
    keep(many.root)
    expect(
      flip(many.rows.slice(1), () => {
        many.rows[0]!.remove()
      }),
    ).toEqual([])
    expect(many.rows[0]!.isConnected).toBe(false)
    await reduced(() => {
      const { root, rows } = list(3)
      keep(root)
      expect(
        flip(rows.slice(1), () => {
          rows[0]!.remove()
        }),
      ).toEqual([])
      expect(rows[0]!.isConnected).toBe(false)
    })
  })

  it('wipes a resolved card with one cover, then takes it away and lets the rest rise on the spring', async () => {
    const { root, rows } = list(3)
    keep(root)
    const words = rows[0]!.textContent
    let removed = 0
    const done = resolveAndRise(rows[0]!, rows.slice(1), () => {
      removed++
      rows[0]!.remove()
    })
    const cover = rows[0]!.querySelector('.ui-wipe')!
    expect(cover.getAttribute('aria-hidden')).toBe('true')
    expect(getComputedStyle(cover).position).toBe('absolute')
    const [wipe] = moves(cover)
    expect(keyframes(wipe!).map(frame => frame.transform)).toEqual(['scaleX(0)', 'scaleX(1)'])
    expect(timing(wipe!).duration).toBe(MOTION.wipe)
    // The card's own words do not move or change while the cover crosses.
    expect(moves(rows[0]!)).toEqual([])
    expect(rows[0]!.firstChild?.textContent).toBe(words)
    // A second receipt for the same card starts nothing new.
    expect(resolveAndRise(rows[0]!, rows.slice(1), () => removed++)).toBe(done)
    expect(rows[0]!.querySelectorAll('.ui-wipe')).toHaveLength(1)
    expect(removed).toBe(0)
    wipe!.finish()
    await done
    expect(removed).toBe(1)
    expect(moves(rows[1]!).map(item => timing(item).easing)).toEqual([curve(EASING.spring)])
  })

  it('takes a resolved card away at once with reduced motion', async () => {
    await reduced(async () => {
      const { root, rows } = list(2)
      keep(root)
      let removed = false
      await resolveAndRise(rows[0]!, rows.slice(1), () => {
        removed = true
        rows[0]!.remove()
      })
      expect(removed).toBe(true)
      expect(document.querySelector('.ui-wipe')).toBeNull()
      expect(moves(rows[1]!)).toEqual([])
    })
  })

  it('moves a row to another lane: it leaves, the lanes close and open, it arrives', async () => {
    const from = list(2)
    const to = list(1)
    keep(from.root)
    keep(to.root)
    const row = from.rows[0]!
    const moved = moveLane(row, [from.rows[1]!, to.rows[0]!], () => {
      to.root.prepend(row)
      return row
    })
    expect(row.parentElement).toBe(from.root)
    moves(row)[0]!.finish()
    await moved
    expect(row.parentElement).toBe(to.root)
    // It arrives from the hidden pose its exit left it in.
    expect(keyframes(moves(row)[0]!).at(-1)).toMatchObject({ opacity: '1', transform: 'none' })
    // The row it left behind closes the gap.
    expect(moves(from.rows[1]!)).toHaveLength(1)
  })

  it('leaves a row where it is when it comes back while leaving, and just moves it with reduced motion', async () => {
    const from = list(2)
    const to = list(1)
    keep(from.root)
    keep(to.root)
    let calls = 0
    const moved = moveLane(from.rows[0]!, [], () => {
      calls++
    })
    enter(from.rows[0]!)
    await moved
    expect(calls).toBe(0)
    await reduced(async () => {
      await moveLane(from.rows[1]!, [], () => {
        calls++
        to.root.append(from.rows[1]!)
      })
      expect(calls).toBe(1)
      expect(moves(from.rows[1]!)).toEqual([])
    })
  })
})

describe('layout-switch, menu, send-lift and done-sheen', () => {
  it('cross-fades the window for a layout change and lets a second change take over', async () => {
    const root = document.documentElement
    const applied: string[] = []
    const first = crossFade(() => applied.push('first'), 'layoutSwitch')
    const second = crossFade(() => applied.push('second'), 'layoutSwitch')
    await Promise.all([first, second])
    expect(applied).toEqual(['first', 'second'])
    expect([root.dataset.crossFade, root.dataset.layoutSwitch]).toEqual([undefined, undefined])
  })

  it('changes the layout at once with reduced motion', async () => {
    await reduced(() => {
      let applied = false
      void crossFade(() => {
        applied = true
      })
      expect(applied).toBe(true)
      expect(document.documentElement.dataset.crossFade).toBeUndefined()
    })
  })

  it('keeps the later layout when motion is reduced before the first update runs', async () => {
    const root = document.documentElement
    const applied: string[] = []
    const first = crossFade(() => applied.push('first'), 'layoutSwitch')
    const firstWasQueued = applied.length === 0
    setReducedMotion(true)
    const second = crossFade(() => applied.push('second'), 'layoutSwitch')
    await Promise.all([first, second])
    expect(firstWasQueued).toBe(true)
    expect(applied).toEqual(['first', 'second'])
    expect([root.dataset.crossFade, root.dataset.layoutSwitch]).toEqual([undefined, undefined])
  })

  it('changes the layout without a snapshot of a visible security surface', async () => {
    const surface = keep(box('待批准操作'))
    surface.dataset.secure = ''
    const start = vi.spyOn(document, 'startViewTransition')
    try {
      const apply = vi.fn()
      const next = crossFade(apply)
      const appliedImmediately = apply.mock.calls.length
      await next
      expect(appliedImmediately).toBe(1)
      expect(start).not.toHaveBeenCalled()

      surface.hidden = true
      await crossFade(apply)
      expect(start).toHaveBeenCalledTimes(1)
      expect(apply).toHaveBeenCalledTimes(2)
    } finally {
      start.mockRestore()
    }
  })

  it('keeps the later layout when a security surface appears during a cross-fade', async () => {
    const applied: string[] = []
    const first = crossFade(() => applied.push('first'))
    const surface = keep(box('待批准操作'))
    surface.dataset.secure = ''
    const second = crossFade(() => applied.push('second'))
    await Promise.all([first, second])
    expect(applied).toEqual(['first', 'second'])
    expect(document.documentElement.dataset.crossFade).toBeUndefined()
  })

  it("brings a menu's items in 18ms apart, the first eight only, and none with reduced motion", async () => {
    const { root, rows } = list(10)
    keep(root)
    const animations = stagger(rows)
    expect(animations.map(item => timing(item).delay)).toEqual([0, 18, 36, 54, 72, 90, 108, 126])
    expect(moves(rows[8]!)).toEqual([])
    expect(properties(animations[0]!).toSorted()).toEqual(['opacity', 'transform'])
    // Opened again before the first pass ended: each item starts from where it is, with one animation.
    animations[0]!.currentTime = MOTION.enter / 2
    stagger(rows)
    expect(moves(rows[0]!)).toHaveLength(1)
    await reduced(() => {
      expect(stagger(rows)).toEqual([])
    })
  })

  it('lifts a sent message from the input to its place over 320ms on the settle curve', async () => {
    const message = keep(box('修一下保存逻辑'))
    const at = message.getBoundingClientRect()
    const animation = sendLift(message, { left: at.left + 10, top: at.top + 200 })!
    expect(keyframes(animation).map(frame => frame.transform)).toEqual(['translate(10px, 200px)', 'none'])
    expect([timing(animation).duration, timing(animation).easing]).toEqual([MOTION.push, curve(EASING.settle)])
    expect(properties(animation).toSorted()).toEqual(['opacity', 'transform'])
    // Sent again at once: the first lift is cancelled, not queued.
    sendLift(message, { left: at.left, top: at.top + 100 })
    expect(moves(message)).toHaveLength(1)
    await reduced(() => {
      expect(sendLift(message, { left: 0, top: 0 })).toBeNull()
    })
  })

  it('crosses a finished action with one light, once, and never on a security surface or with reduced motion', async () => {
    const screen = await render(
      <div>
        <Button variant="primary">允许写入</Button>
        <div data-secure="">
          <Button variant="primary">批准</Button>
        </div>
      </div>,
    )
    const button = screen.getByRole('button', { name: '允许写入' }).element() as HTMLElement
    const animation = sheenOnce(button)!
    expect(timing(animation).duration).toBe(MOTION.sheen)
    expect(properties(animation)).toEqual(['transform'])
    expect(sheenOnce(button)).toBeNull()
    expect(button.querySelectorAll('.ui-sheen')).toHaveLength(1)
    expect(button.querySelector('.ui-sheen')!.getAttribute('aria-hidden')).toBe('true')
    animation.finish()
    await frames()
    expect(button.querySelector('.ui-sheen')).toBeNull()
    expect(sheenOnce(screen.getByRole('button', { name: '批准' }).element() as HTMLElement)).toBeNull()
    await reduced(() => {
      expect(sheenOnce(button)).toBeNull()
    })
  })
})

describe('moves a stylesheet runs', () => {
  /** Every style rule of the page whose selector matches. */
  function rules(selector: RegExp): CSSStyleRule[] {
    const found: CSSStyleRule[] = []
    const walk = (list: CSSRuleList) => {
      for (const rule of Array.from(list)) {
        if (rule instanceof CSSStyleRule && selector.test(rule.selectorText)) found.push(rule)
        else if (rule instanceof CSSGroupingRule) walk(rule.cssRules)
      }
    }
    for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules)
    return found
  }

  it('presses a control down in 80ms and releases it on the spring; a transition, so a release mid-press turns round', async () => {
    const chip = keep(document.createElement('button'))
    chip.className = 'ui-press'
    document.body.append(chip)
    const style = getComputedStyle(chip)
    expect([style.transitionProperty, style.transitionDuration, curve(style.transitionTimingFunction)]).toEqual([
      'transform',
      '0.42s',
      curve(EASING.spring),
    ])
    const [pressed] = rules(/^\.ui-press:active/u)
    expect(pressed!.style.transform).toBe('scale(var(--s-press))')
    expect(pressed!.style.transition).toContain('var(--m-press)')
    expect(getComputedStyle(chip).getPropertyValue('--s-press').trim()).toBe('0.97')
    await reduced(() => {
      expect(getComputedStyle(chip).transitionDuration).toBe('0s')
    })
  })

  function Pill({ initial }: { initial: boolean }) {
    const [show, setShow] = useState(initial)
    return (
      <div>
        <button type="button" onClick={() => setShow(!show)}>
          toggle
        </button>
        <PillMove show={show}>回到最新</PillMove>
      </div>
    )
  }

  it('raises the pill on the spring, lets it leave on the exit curve, and brings it back if it is wanted again', async () => {
    const screen = await render(<Pill initial />)
    const pill = () => screen.container.querySelector<HTMLElement>('.ui-pill-move')
    // Interrupt the 112ms exit in the same browser task, before its unmount timer can run.
    const toggle = screen.getByRole('button').element() as HTMLButtonElement
    expect([getComputedStyle(pill()!).animationName, getComputedStyle(pill()!).animationDuration]).toEqual(['ui-pill-in', '0.42s'])
    flushSync(() => toggle.click())
    expect(pill()!.dataset.leaving).toBe('')
    expect(pill()!.inert).toBe(true)
    expect([getComputedStyle(pill()!).animationName, getComputedStyle(pill()!).animationDuration]).toEqual(['ui-pill-out', '0.112s'])
    // Wanted again while it leaves: the same element stays and is no longer leaving.
    const leaving = pill()
    flushSync(() => toggle.click())
    expect(pill()).toBe(leaving)
    expect(pill()!.dataset.leaving).toBeUndefined()
    await screen.getByRole('button').click()
    await expect.poll(pill).toBeNull()
  })

  it('only fades the pill with reduced motion, and takes it away at once', async () => {
    await reduced(async () => {
      const screen = await render(<Pill initial />)
      const pill = () => screen.container.querySelector<HTMLElement>('.ui-pill-move')
      expect(getComputedStyle(pill()!).animationName).toBe('ui-fade-in')
      await screen.getByRole('button').click()
      await expect.poll(pill).toBeNull()
    })
  })

  function Counter({ start }: { start: number }) {
    const [count, setCount] = useState(start)
    return (
      <LiveChanges value="test">
        <button type="button" onClick={() => setCount(count - 1)}>
          less
        </button>
        <button type="button" onClick={() => setCount(count + 5)}>
          more
        </button>
        <Roll value={count} />
      </LiveChanges>
    )
  }

  it('rolls a count down when it falls and up when it rises, and restarts from the arriving figure when it changes again', async () => {
    const screen = await render(<Counter start={4} />)
    const roll = () => screen.container.querySelector<HTMLElement>('.ui-roll')!
    // The first render shows the figure at once.
    expect([roll().dataset.roll, roll().querySelector('.ui-roll-out')]).toEqual([undefined, null])
    await screen.getByRole('button', { name: 'less' }).click()
    expect(roll().dataset.roll).toBe('down')
    expect([roll().querySelector('.ui-roll-out')!.textContent, roll().querySelector('.ui-roll-in')!.textContent]).toEqual(['4', '3'])
    expect(getComputedStyle(roll().querySelector('.ui-roll-in')!).animationName).toBe('ui-roll-in')
    expect(getComputedStyle(roll().querySelector('.ui-roll-in')!).animationDuration).toBe('0.24s')
    expect(roll().querySelector('.ui-roll-out')!.getAttribute('aria-hidden')).toBe('true')
    // Changed again while it rolls: one old figure, the one that was arriving.
    await screen.getByRole('button', { name: 'more' }).click()
    expect(roll().dataset.roll).toBe('up')
    expect(roll().querySelectorAll('.ui-roll-out')).toHaveLength(1)
    expect([roll().querySelector('.ui-roll-out')!.textContent, roll().querySelector('.ui-roll-in')!.textContent]).toEqual(['3', '8'])
    await expect.poll(() => roll().querySelector('.ui-roll-out')).toBeNull()
    expect(roll().textContent).toBe('8')
  })

  it('just shows the new count with reduced motion, and never rolls outside a live page', async () => {
    await reduced(async () => {
      const screen = await render(<Counter start={4} />)
      await screen.getByRole('button', { name: 'less' }).click()
      expect(screen.container.querySelector('.ui-roll-out')).toBeNull()
      expect(screen.container.querySelector('.ui-roll')!.textContent).toBe('3')
    })
    function Bare() {
      const [count, setCount] = useState(1)
      return (
        <button type="button" onClick={() => setCount(count + 1)}>
          <Roll value={count} />
        </button>
      )
    }
    const screen = await render(<Bare />)
    await screen.getByRole('button', { name: '1' }).click()
    expect(screen.container.querySelector('.ui-roll-out')).toBeNull()
  })

  function Sections({ epoch }: { epoch: string }) {
    const [more, setMore] = useState(false)
    return (
      <LiveChanges value={epoch}>
        <button type="button" onClick={() => setMore(true)}>
          add
        </button>
        <SectionTitle title="等你处理" count={4} />
        {more && <SectionTitle title="可交付" count={1} />}
      </LiveChanges>
    )
  }

  it("draws a section's rule only for a section the page saw appear, once, from the start edge", async () => {
    const screen = await render(<Sections epoch="rule-a" />)
    const rule = (index: number) => getComputedStyle(screen.container.querySelectorAll('.ui-section-title')[index]!, '::after')
    // On the first load the rule is simply there.
    expect(rule(0).animationName).toBe('none')
    await frames()
    await screen.getByRole('button', { name: 'add' }).click()
    expect([
      rule(1).animationName,
      rule(1).animationDuration,
      rule(1).animationIterationCount,
      rule(1).transformOrigin.split(' ')[0],
    ]).toEqual(['ui-rule-in', '0.42s', '1', '0px'])
    expect(rule(0).animationName).toBe('none')
    await reduced(() => {
      expect(rule(1).animationName).toBe('none')
    })
    document.documentElement.dataset.motion = 'reduce'
    expect(rule(1).animationName).toBe('none')
  })

  it('draws no rule after a resynchronization, outside a live page, or for a section that arrives with motion reduced', async () => {
    // Without a provider nothing is seen live.
    const bare = await render(<SectionTitle title="进行中" count={2} />)
    expect(bare.container.querySelector('.ui-section-title')!.hasAttribute('data-draw')).toBe(false)
    await bare.unmount()
    const screen = await render(<Sections epoch="rule-b" />)
    await frames()
    // A new epoch: everything on screen is established again, and what mounts with it is not an arrival.
    await screen.rerender(<Sections key="again" epoch="rule-c" />)
    expect([...screen.container.querySelectorAll('.ui-section-title')].some(title => title.hasAttribute('data-draw'))).toBe(false)
    await frames()
    await reduced(async () => {
      await screen.getByRole('button', { name: 'add' }).click()
      expect(screen.container.querySelectorAll('.ui-section-title')[1]!.hasAttribute('data-draw')).toBe(false)
    })
  })

  it('runs the edge of a running row and the live dot only while motion is allowed, and pauses them out of view', async () => {
    const screen = await render(
      <div style={{ position: 'relative', width: 200 }}>
        <RunningEdge />
        <LiveDot live label="在线" />
        <LiveDot live={false} label="离线" />
      </div>,
    )
    const light = screen.container.querySelector('.ui-running-edge > i')!
    const [live, offline] = [...screen.container.querySelectorAll('.ui-live-dot')]
    const edge = () => getComputedStyle(light)
    const pulse = (dot: Element) => getComputedStyle(dot, '::after')
    expect([edge().animationName, edge().animationDuration, edge().animationIterationCount]).toEqual(['ui-run-edge', '2.4s', 'infinite'])
    expect([pulse(live!).animationName, pulse(offline!).animationName]).toEqual(['ui-live-pulse', 'none'])
    expect(screen.container.querySelector('.ui-running-edge')!.getAttribute('aria-hidden')).toBe('true')
    expect([live!.getAttribute('aria-label'), offline!.getAttribute('aria-label')]).toEqual(['在线', '离线'])
    screen.container.querySelector('.ui-running-edge')!.setAttribute('data-offscreen', '')
    expect(edge().animationPlayState).toBe('paused')
    screen.container.querySelector('.ui-running-edge')!.removeAttribute('data-offscreen')
    await reduced(() => {
      // Not drawn at all: the row's spinner and words say it runs.
      expect([edge().display, pulse(live!).animationName]).toEqual(['none', 'none'])
    })
    document.documentElement.dataset.motion = 'reduce'
    expect([edge().display, pulse(live!).animationName]).toEqual(['none', 'none'])
  })
})

describe('on a security surface', () => {
  it('runs no move on or inside it: what an approval shows never moves, fades or flashes', async () => {
    const surface = keep(document.createElement('div'))
    surface.dataset.secure = ''
    document.body.append(surface)
    const { root, rows } = list(4)
    surface.append(root)
    expect(enter(rows[0]!)).toBeNull()
    expect(enter(surface)).toBeNull()
    expect(stagger(rows)).toEqual([])
    expect(sendLift(rows[1]!, { left: 0, top: 0 })).toBeNull()
    expect(sheenOnce(rows[1]!)).toBeNull()
    expect(
      flip(rows.slice(1), () => {
        rows[0]!.remove()
      }),
    ).toEqual([])
    expect(rows[0]!.isConnected).toBe(false)
    expect(await exit(rows[1]!)).toBe(true)
    expect(getComputedStyle(rows[1]!).opacity).toBe('1')
    let removed = false
    await resolveAndRise(rows[2]!, [rows[3]!], () => {
      removed = true
    })
    expect(removed).toBe(true)
    expect(surface.querySelector('.ui-wipe, .ui-sheen')).toBeNull()
    expect([surface, ...rows].flatMap(element => element.getAnimations())).toEqual([])
    // Rows outside it that make room for it still slide: only the surface itself stays put.
    const outside = list(2)
    keep(outside.root)
    expect(
      flip([outside.rows[1]!], () => {
        outside.rows[0]!.remove()
      }),
    ).toHaveLength(1)
  })

  it('does not move a container with a security surface inside it', () => {
    const container = keep(box())
    const surface = document.createElement('section')
    surface.dataset.secure = ''
    container.append(surface)
    expect(enter(container)).toBeNull()
    expect(moves(container)).toEqual([])
  })

  it('rechecks which containers can move after the document changes', () => {
    const { root, rows } = list(3)
    keep(root)
    const protectedRow = rows[1]!
    const ordinaryRow = rows[2]!
    const shifted = flip([protectedRow, ordinaryRow], () => {
      rows[0]!.remove()
      const surface = document.createElement('section')
      surface.dataset.secure = ''
      protectedRow.append(surface)
    })
    expect(shifted).toHaveLength(1)
    expect(moves(protectedRow)).toEqual([])
    expect(moves(ordinaryRow)).toEqual(shifted)
  })
})

describe('where text is streaming', () => {
  it('runs no move on a streaming layer or inside it: the change just shows', async () => {
    const { root, rows } = list(3)
    keep(root)
    const unmark = markStreaming(root)
    try {
      expect(enter(rows[0]!)).toBeNull()
      expect(await exit(rows[0]!)).toBe(true)
      expect(stagger(rows)).toEqual([])
      expect(sendLift(rows[1]!, { left: 0, top: 0 })).toBeNull()
      expect(sheenOnce(rows[1]!)).toBeNull()
      expect(
        flip(rows.slice(1), () => {
          rows[0]!.remove()
        }),
      ).toEqual([])
      let removed = false
      await resolveAndRise(rows[1]!, [rows[2]!], () => {
        removed = true
      })
      expect(removed).toBe(true)
      expect(root.querySelector('.ui-wipe')).toBeNull()
      expect(rows.some(moving)).toBe(false)
    } finally {
      unmark()
    }
    expect(enter(rows[1]!)).not.toBeNull()
  })

  it('pauses the loops of the page while a streaming reply is in view, and lets them run when it ends', async () => {
    const screen = await render(
      <div style={{ position: 'relative', width: 200 }}>
        <RunningEdge />
        <LiveDot live />
        <p>reply</p>
      </div>,
    )
    const light = screen.container.querySelector('.ui-running-edge > i')!
    const dot = screen.container.querySelector('.ui-live-dot')!
    const states = () => [getComputedStyle(light).animationPlayState, getComputedStyle(dot, '::after').animationPlayState]
    expect(states()).toEqual(['running', 'running'])
    const unmark = markStreaming(screen.container.querySelector('p')!)
    await expect.poll(streamingInView).toBe(true)
    expect(document.documentElement.hasAttribute('data-streaming-view')).toBe(true)
    expect(states()).toEqual(['paused', 'paused'])
    unmark()
    expect(streamingInView()).toBe(false)
    expect(states()).toEqual(['running', 'running'])
  })
})

describe('减弱 and 开 on this device', () => {
  it('stills every animation and transition of the page for 减弱, whatever the system says', async () => {
    const screen = await render(
      <div>
        <Spinner />
        <Button>继续</Button>
      </div>,
    )
    const spinner = screen.container.querySelector('.ui-spinner')!
    expect(getComputedStyle(spinner).animationIterationCount).toBe('infinite')
    expect(motionAllowed()).toBe(true)
    document.documentElement.dataset.motion = 'reduce'
    expect(motionAllowed()).toBe(false)
    const style = getComputedStyle(spinner)
    expect([style.animationIterationCount, parseFloat(style.animationDuration)]).toEqual(['1', 0.00001])
    expect(parseFloat(getComputedStyle(screen.getByRole('button').element()).transitionDuration)).toBe(0.00001)
    // Scripted moves ask the same question.
    const row = keep(box())
    expect(properties(enter(row)!)).toEqual(['opacity'])
  })

  it('keeps the capture freeze apart from the setting: applying 动效 never clears it', async () => {
    const root = document.documentElement
    // The visual tests freeze the page before it loads; then the page applies its stored preference.
    root.dataset.capture = 'still'
    expect(captureStill()).toBe(true)
    setReducedMotion(false)
    expect([root.dataset.capture, root.dataset.motion, captureStill(), motionAllowed()]).toEqual(['still', undefined, true, true])
    setReducedMotion(true)
    expect([root.dataset.capture, root.dataset.motion, captureStill(), motionAllowed()]).toEqual(['still', 'reduce', true, false])
    setReducedMotion(false)
    expect([root.dataset.capture, root.dataset.motion]).toEqual(['still', undefined])
    // And the freeze is not a motion choice: it shortens no token and stills no stylesheet by itself.
    expect(getComputedStyle(root).getPropertyValue('--m-panel').trim()).toBe('200ms')
    delete root.dataset.capture
    expect(captureStill()).toBe(false)
  })

  it('tells a watcher when the setting, the capture freeze or the system preference changes, until it stops watching', async () => {
    const root = document.documentElement
    let changes = 0
    const stop = watchMotion(() => changes++)
    const settled = async () => {
      await frames()
      return changes
    }
    setReducedMotion(true)
    expect(await settled()).toBe(1)
    root.dataset.capture = 'still'
    expect(await settled()).toBe(2)
    await reduced(async () => {
      expect(await settled()).toBe(3)
    })
    const before = await settled()
    // Another attribute of the root is not its business.
    root.dataset.theme = 'dark'
    delete root.dataset.theme
    expect(await settled()).toBe(before)
    stop()
    setReducedMotion(false)
    delete root.dataset.capture
    expect(await settled()).toBe(before)
  })

  it('offers no way to force motion on: an unknown choice on the root follows the system', async () => {
    document.documentElement.dataset.motion = 'full'
    expect(motionAllowed()).toBe(true)
    await reduced(() => {
      expect(motionAllowed()).toBe(false)
      const row = keep(box())
      expect(properties(enter(row)!)).toEqual(['opacity'])
    })
  })

  it('tells a component that a change it saw live may not be animated under 减弱', async () => {
    // The composer's send and stop slot, a count and a status slot all animate only when `live` is true.
    const seen: boolean[] = []
    function Slot({ value }: { value: string }) {
      useLiveChange(value, (_previous, live) => {
        seen.push(live)
      })
      return <span>{value}</span>
    }
    const screen = await render(
      <LiveChanges value="slot">
        <Slot value="send" />
      </LiveChanges>,
    )
    await screen.rerender(
      <LiveChanges value="slot">
        <Slot value="stop" />
      </LiveChanges>,
    )
    document.documentElement.dataset.motion = 'reduce'
    await screen.rerender(
      <LiveChanges value="slot">
        <Slot value="send" />
      </LiveChanges>,
    )
    expect(seen).toEqual([true, false])
  })
})
