import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { Check, Circle, CircleDot, Terminal } from 'lucide-react'
import {
  Comet,
  Count,
  Icon,
  LiveChanges,
  StatusGlyph,
  StatusSlot,
  StatusWords,
  WaitingPill,
  useLivePrevious,
  type SlotStatus,
} from '../src/index.ts'
import { protocol } from './helpers.ts'

const frames = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
const pause = (ms: number) => new Promise(done => setTimeout(done, ms))

/** The CSS animation running on `element` (or on its `pseudo` element), by name. */
function animation(element: Element, pseudo: string | null = null): CSSAnimation | undefined {
  return document
    .getAnimations()
    .find(
      (item): item is CSSAnimation =>
        item instanceof CSSAnimation
        && item.effect instanceof KeyframeEffect
        && item.effect.target === element
        && item.effect.pseudoElement === pseudo,
    )
}

/** Where in its turn an animation is, 0 to 1. */
const progress = (item: Animation | undefined) => item?.effect?.getComputedTiming().progress ?? Number.NaN
/** The distance between two points on a circle of circumference 1. */
const apart = (a: number, b: number) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b))

/** The relay's numbering of each live item: [its slot, the cycle, the cycle that picks its keyframes]. */
function numbering(container: HTMLElement): Array<[string, string, string | null]> {
  return Array.from(container.querySelectorAll<HTMLElement>('.ui-comet, .ui-waiting-pill'), item => [
    item.style.getPropertyValue('--i'),
    item.style.getPropertyValue('--cyc'),
    item.getAttribute('data-relay'),
  ])
}

/** `epoch` stands for the page's resynchronization epoch: a change made under a new epoch was not seen live. */
function Live({ epoch, children }: { epoch: number; children: ReactNode }) {
  return <LiveChanges value={epoch}>{children}</LiveChanges>
}

const count = (epoch: number, value: number) => (
  <Live epoch={epoch}>
    <Count value={value} tone="warn" />
  </Live>
)

/** A row that shows its waiting count only above zero, as the sidebar's 待批准 row does. */
function Waiting({ value }: { value: number }) {
  const before = useLivePrevious(value)
  return <div>{value > 0 && <Count value={value} tone="warn" from={before} />}</div>
}

const arrival = (epoch: number, value: number) => (
  <Live epoch={epoch}>
    <Waiting value={value} />
  </Live>
)

const slot = (epoch: number, status: SlotStatus) => (
  <Live epoch={epoch}>
    <StatusSlot status={status} time="09:15" />
  </Live>
)

type ProcessState = 'running' | 'completed'

/** A process row: its glyph and the words of its state. */
const row = (epoch: number, state: ProcessState) => (
  <Live epoch={epoch}>
    <StatusGlyph running={state === 'running'} size={14}>
      <Icon icon={Terminal} size={16} />
    </StatusGlyph>
    <StatusWords state={state}>{state === 'running' ? '执行中' : '完成'}</StatusWords>
  </Live>
)

const step = (epoch: number, state: 'pending' | 'in_progress' | 'completed') => (
  <Live epoch={epoch}>
    <StatusGlyph state={state}>
      <Icon icon={state === 'completed' ? Check : state === 'in_progress' ? CircleDot : Circle} size={14} />
    </StatusGlyph>
  </Live>
)

const scene = (value: number, status: SlotStatus, state: ProcessState = 'running') => (
  <Live epoch={1}>
    <Comet label="运行中" />
    <WaitingPill>待批准</WaitingPill>
    <Count value={value} tone="warn" />
    <StatusSlot status={status} time="09:15" />
    <StatusGlyph running={state === 'running'}>
      <Icon icon={Terminal} size={14} />
    </StatusGlyph>
    <StatusWords state={state}>{state}</StatusWords>
  </Live>
)

/** `n` relayed comets in a column. */
const comets = (n: number) => (
  <div>
    {Array.from({ length: n }, (_, index) => (
      <Comet key={index} label={String(index)} />
    ))}
  </div>
)

/** The duration and curve an element animates with, and the tokens they should come from. */
function timing(element: Element): { duration: string; easing: string } {
  const style = getComputedStyle(element)
  return { duration: style.animationDuration, easing: style.animationTimingFunction }
}
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

describe('live indicators', () => {
  it('turns every comet in one shared phase, whenever it mounted', async () => {
    const first = await render(<Comet label="运行中" relay={false} />)
    await pause(700)
    const second = await render(<Comet size={16} label="运行中" relay={false} />)
    const [a, b] = [first, second].map(screen => animation(screen.container.querySelector('.ui-comet-drift')!))
    await Promise.all([a?.ready, b?.ready])
    expect([a?.animationName, b?.animationName]).toEqual(['ui-comet-turn', 'ui-comet-turn'])
    expect(a?.effect?.getComputedTiming().duration).toBe(2400)
    // Both stand where the document timeline puts them, so they turn as one.
    expect(apart(progress(a), progress(b))).toBeLessThan(0.05)
    const now = Number(document.timeline.currentTime)
    expect(apart(progress(a), (now % 2400) / 2400)).toBeLessThan(0.05)
  })

  it('puts a comet back in the shared phase when its turn starts again, as after being hidden', async () => {
    const screen = await render(
      <div>
        <Comet label="一直在" relay={false} />
        <span className="later">
          <Comet label="重新显示" relay={false} />
        </span>
      </div>,
    )
    const later = screen.container.querySelector<HTMLElement>('.later')!
    later.style.display = 'none'
    await pause(900)
    later.style.display = ''
    const drift = (name: string) => animation(screen.getByRole('img', { name }).element().querySelector('.ui-comet-drift')!)
    await drift('重新显示')?.ready
    await frames()
    expect(apart(progress(drift('一直在')), progress(drift('重新显示')))).toBeLessThan(0.02)
  })

  it('holds a comet that no longer runs where the shared turn had it, with no motion and no place in the relay', async () => {
    const screen = await render(<Comet label="已停" held />)
    const mounted = (Number(document.timeline.currentTime) % 2400) / 2400
    const held = screen.getByRole('img', { name: '已停' }).element()
    const turn = () => (Number.parseFloat(getComputedStyle(held.querySelector('.ui-comet-held')!).rotate) || 0) / 360
    // It stands where every running comet stood when it mounted, and stays there.
    expect(apart(turn(), mounted)).toBeLessThan(0.05)
    const before = turn()
    await pause(300)
    expect(turn()).toBe(before)
    expect([held.querySelector('.ui-comet-drift, .ui-comet-lap'), held.getAttribute('data-relay')]).toEqual([null, null])
    expect(held.getAnimations({ subtree: true })).toEqual([])
    expect(held.querySelector('circle')).not.toBeNull()
  })

  it('draws the still frame of a comet: the head at 12 o’clock and the tail down the left, on the track', async () => {
    const screen = await render(<Comet size={12} label="运行中" />)
    const comet = screen.getByRole('img', { name: '运行中' }).element()
    const style = getComputedStyle(comet)
    expect([style.width, style.height, style.borderRadius]).toEqual(['12px', '12px', '50%'])
    expect(style.boxShadow).toContain('1.5px inset')
    const head = comet.querySelector('circle')!
    expect([head.getAttribute('cx'), head.getAttribute('cy'), head.getAttribute('r')]).toEqual(['12', '1.5', '1.86'])
    expect(comet.querySelector('path')!.getAttribute('d')).toBe('M12 1.5A10.5 10.5 0 0 0 8.409 21.867')
  })

  it('numbers the visible live items from the top down and relays them in a cycle of max(3, n) slots', async () => {
    // Laid out bottom-up, so the numbering follows the page rather than the order of the markup; the hidden one waits.
    const screen = await render(
      <div style={{ display: 'flex', flexDirection: 'column-reverse', alignItems: 'start', gap: 8 }}>
        <Comet label="a" />
        <WaitingPill>待批准</WaitingPill>
        <Comet label="c" />
        <Comet label="d" />
        <span hidden>
          <Comet label="hidden" />
        </span>
      </div>,
    )
    await expect
      .poll(() => numbering(screen.container))
      .toEqual([
        ['3', '4', '4'],
        ['2', '4', '4'],
        ['1', '4', '4'],
        ['0', '4', '4'],
        ['', '', null],
      ])
    await frames()
    // One lap of 1.6s in a cycle of four slots, starting in the item's own slot; the pill sweeps its band instead.
    const lap = animation(screen.getByRole('img', { name: 'c' }).element().querySelector('.ui-comet-lap')!)
    expect([lap?.animationName, lap?.effect?.getTiming().duration, lap?.effect?.getTiming().delay]).toEqual(['ui-relay-lap-4', 6400, 1600])
    const sweep = animation(screen.getByText('待批准').element(), '::before')
    expect([sweep?.animationName, sweep?.effect?.getTiming().duration, sweep?.effect?.getTiming().delay]).toEqual([
      'ui-relay-sweep-4',
      6400,
      3200,
    ])
    // Every relay animation starts together, so exactly one slot is the current one.
    const starts = Array.from(screen.container.querySelectorAll('.ui-comet-lap'), item => animation(item)?.startTime).filter(
      time => time !== undefined,
    )
    expect(new Set(starts).size).toBe(1)
  })

  it('numbers the items of one line by their centres from left to right, whatever their sizes', async () => {
    // Centred on one line, the 16 and the pill have higher tops than the 12 on their left; on the line below, aligned
    // at the bottom, the centres are 2px apart.
    const screen = await render(
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'start', gap: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Comet size={12} label="a" />
          <Comet size={16} label="b" />
          <WaitingPill>待批准</WaitingPill>
          <Comet size={14} label="c" />
        </div>
        <div style={{ display: 'flex', alignItems: 'end', gap: 8 }}>
          <Comet size={16} label="d" />
          <Comet size={12} label="e" />
        </div>
      </div>,
    )
    await expect
      .poll(() => numbering(screen.container))
      .toEqual(Array.from({ length: 6 }, (_, index): [string, string, string] => [String(index), '6', '6']))
  })

  it('keeps a cycle of three slots for fewer items and relays only the first eight of more', async () => {
    const few = await render(
      <div>
        <Comet label="1" />
        <Comet label="2" />
      </div>,
    )
    await expect
      .poll(() => numbering(few.container))
      .toEqual([
        ['0', '3', '3'],
        ['1', '3', '3'],
      ])
    await few.unmount()
    const many = await render(
      <div>
        {Array.from({ length: 10 }, (_, index) => (
          <Comet key={index} label={String(index)} />
        ))}
      </div>,
    )
    await expect
      .poll(() => numbering(many.container))
      .toEqual([
        ...Array.from({ length: 8 }, (_, index): [string, string, string] => [String(index), '8', '8']),
        ['', '', null],
        ['', '', null],
      ])
  })

  it('leaves out of the relay an item at opacity 0, as a row’s status while its ⋯ shows, and takes it back after', async () => {
    const screen = await render(
      <div>
        <Comet label="a" />
        <span className="covered">
          <Comet label="b" />
        </span>
        <Comet label="c" />
      </div>,
    )
    await expect.poll(() => numbering(screen.container).map(([index]) => index)).toEqual(['0', '1', '2'])
    const covered = screen.container.querySelector<HTMLElement>('.covered')!
    covered.style.opacity = '0'
    // Measured again at the next slot boundary: the hidden one no longer takes a turn nobody would see.
    await expect
      .poll(() => numbering(screen.container), { timeout: 4000 })
      .toEqual([
        ['0', '3', '3'],
        ['', '', null],
        ['1', '3', '3'],
      ])
    covered.style.opacity = ''
    await expect.poll(() => numbering(screen.container).map(([index]) => index), { timeout: 4000 }).toEqual(['0', '1', '2'])
  })

  it('applies a new numbering at a slot boundary, so no lap or sweep is cut short', async () => {
    const screen = await render(comets(4))
    await expect.poll(() => numbering(screen.container).map(([, cycle]) => cycle)).toEqual(['4', '4', '4', '4'])
    await frames()
    const lap = () => animation(screen.getByRole('img', { name: '0' }).element().querySelector('.ui-comet-lap')!)
    const first = lap()?.startTime
    expect(typeof first).toBe('number')
    await pause(400)
    await screen.rerender(comets(5))
    await frames()
    // The newcomer waits for the boundary; the four keep their turns meanwhile.
    expect(numbering(screen.container).map(([, cycle]) => cycle)).toEqual(['4', '4', '4', '4', ''])
    await expect.poll(() => numbering(screen.container).map(([, cycle]) => cycle), { timeout: 4000 }).toEqual(['5', '5', '5', '5', '5'])
    await frames()
    // The new numbering started on a boundary of the old one, give or take a frame or two of timer delay.
    const offset = (Number(lap()?.startTime) - Number(first)) % 1600
    expect(Math.min(offset, 1600 - offset)).toBeLessThan(100)
  })

  it('rolls and ripples a count only for a change the page saw happen', async () => {
    const screen = await render(count(1, 2))
    const element = () => screen.container.querySelector('.ui-count')!
    const shots = () => [
      element().querySelector('.ui-count-roll')?.getAttribute('data-direction') ?? null,
      element().querySelector('.ui-count-ripple') !== null,
    ]
    // The first render and a change in a new epoch (a resynchronization) just show the value.
    expect(shots()).toEqual([null, false])
    await screen.rerender(count(2, 3))
    expect([shots(), element().textContent]).toEqual([[null, false], '3'])
    // A rise of one, seen live: the digits roll up once and one ripple goes out.
    await screen.rerender(count(2, 4))
    expect(shots()).toEqual(['up', true])
    expect(animation(element().querySelector('.ui-count-roll > span')!)?.animationName).toBe('ui-count-roll-up')
    const ripple = animation(element().querySelector('.ui-count-ripple > rect')!)
    expect([ripple?.animationName, ripple?.effect?.getTiming().iterations]).toEqual(['ui-count-ripple', 1])
    expect(element().querySelector('.sr-only')?.textContent).toBe('4')
    // Handled: it rolls down without a ripple. A jump of several only ripples.
    await screen.rerender(count(2, 3))
    expect(shots()).toEqual(['down', false])
    await screen.rerender(count(2, 6))
    expect([shots(), element().textContent]).toEqual([[null, true], '6'])
    // Without an epoch from the page nothing is known to be live.
    const bare = await render(<Count value={1} tone="warn" />)
    await bare.rerender(<Count value={2} tone="warn" />)
    expect(bare.container.querySelector('.ui-count-roll, .ui-count-ripple')).toBeNull()
  })

  it('ripples the first arrival of a count shown only above zero when seen live, never after a resynchronization', async () => {
    const screen = await render(arrival(1, 0))
    const shots = () => {
      const element = screen.container.querySelector('.ui-count')
      // A rolling count holds both digits; its value is in the text for screen readers.
      const value = (element?.querySelector('.sr-only') ?? element)?.textContent
      return element && [value, element.querySelector('.ui-count-roll') !== null, element.querySelector('.ui-count-ripple') !== null]
    }
    expect(shots()).toBeNull()
    // 0 → 1 seen live: the count appears with one ripple and no roll, since no 0 was on screen.
    await screen.rerender(arrival(1, 1))
    expect(shots()).toEqual(['1', false, true])
    const ripple = animation(screen.container.querySelector('.ui-count-ripple > rect')!)
    expect([ripple?.animationName, ripple?.effect?.getTiming().iterations]).toEqual(['ui-count-ripple', 1])
    // Once it is on screen, a further rise rolls and ripples as any count does.
    await screen.rerender(arrival(1, 2))
    expect(shots()).toEqual(['2', true, true])
    // 0 → 1 that arrives with a resynchronization just shows.
    await screen.rerender(arrival(1, 0))
    expect(shots()).toBeNull()
    await screen.rerender(arrival(2, 1))
    expect(shots()).toEqual(['1', false, false])
    // As does a first load with something already waiting.
    const loaded = await render(arrival(3, 1))
    expect(loaded.container.querySelector('.ui-count-ripple, .ui-count-roll')).toBeNull()
  })

  it('settles a finished run into the unread dot and a read session into its time, only when seen live', async () => {
    const screen = await render(slot(1, 'running'))
    const element = () => screen.container.querySelector('.ui-status-slot')!
    expect(element().querySelector('.ui-comet')).not.toBeNull()
    await screen.rerender(slot(1, 'unread'))
    expect(element().getAttribute('data-settle')).toBe('ring-dot')
    expect(animation(element().querySelector('.ui-status-leaving')!)?.animationName).toBe('ui-settle-ring')
    expect(animation(element().querySelector('.ui-status-dot')!)?.animationName).toBe('ui-settle-dot-in')
    // The comet that leaves no longer turns or relays.
    expect(element().querySelectorAll('.ui-comet-drift, .ui-comet-lap')).toHaveLength(0)
    await screen.rerender(slot(1, 'time'))
    expect(element().getAttribute('data-settle')).toBe('dot-time')
    expect(animation(element().querySelector('.ui-status-time')!)?.animationName).toBe('ui-fade-in')
    // A switch of session or a resynchronization changes the slot at once.
    await screen.rerender(slot(2, 'running'))
    await screen.rerender(slot(3, 'unread'))
    expect([element().getAttribute('data-settle'), element().querySelector('.ui-status-leaving')]).toEqual([null, null])
  })

  it('shows one thing per status, the failure with its word and the waiting pill with its text', async () => {
    const screen = await render(
      <div>
        <StatusSlot status="failed" />
        <StatusSlot status="waiting" waiting="待确认" />
        <StatusSlot status="failed" failed="权限已变化" />
        <StatusSlot status="unread" />
        <StatusSlot status="time" time="周三" dateTime="2026-10-21T09:15:00+08:00" />
        <StatusSlot status="none" time="09:15" />
      </div>,
    )
    const slots = Array.from(screen.container.querySelectorAll('.ui-status-slot'))
    expect(slots.map(item => item.getAttribute('aria-hidden'))).toEqual(Array(6).fill('true'))
    expect(slots.map(item => item.children.length)).toEqual([1, 1, 1, 1, 1, 0])
    expect(slots[0]?.textContent).toBe('失败')
    expect(slots[0]?.firstElementChild && getComputedStyle(slots[0].firstElementChild).color).toBe('rgb(180, 35, 24)')
    expect(slots[0]?.querySelector('.lucide-triangle-alert')).not.toBeNull()
    expect(slots[1]?.querySelector('.ui-waiting-pill')?.textContent).toBe('待确认')
    expect(slots[2]?.textContent).toBe('权限已变化')
    expect(slots[4]?.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-21T09:15:00+08:00')
  })

  it('cross-fades a process row’s glyph and raises its words over 120ms, only for a change seen live', async () => {
    const screen = await render(row(1, 'running'))
    const glyph = () => screen.container.querySelector('.ui-status-glyph')!
    const words = () => screen.container.querySelector('.ui-status-words')!
    // The first render just shows the comet and the words.
    expect([glyph().hasAttribute('data-shift'), words().hasAttribute('data-shift')]).toEqual([false, false])
    expect(glyph().querySelector('.ui-status-glyph-current .ui-comet-drift')).not.toBeNull()
    expect(glyph().getAttribute('aria-hidden')).toBe('true')
    await screen.rerender(row(1, 'completed'))
    // The comet that leaves is held where the shared turn had it; the tool's icon comes in.
    const leaving = glyph().querySelector('.ui-status-glyph-leaving')!
    const current = glyph().querySelector('.ui-status-glyph-current')!
    expect([leaving.querySelector('.ui-comet-held') !== null, leaving.querySelector('.ui-comet-drift')]).toEqual([true, null])
    expect(current.querySelector('.lucide-terminal')).not.toBeNull()
    expect([animation(leaving)?.animationName, animation(current)?.animationName, animation(words())?.animationName]).toEqual([
      'ui-glyph-out',
      'ui-glyph-in',
      'ui-words-in',
    ])
    expect([timing(leaving), timing(current), timing(words())]).toEqual([
      { duration: '0.12s', easing: token('--ease-exit') },
      { duration: '0.12s', easing: token('--ease') },
      { duration: '0.12s', easing: token('--ease') },
    ])
    expect(token('--d-fast')).toBe('120ms')
    expect(words().textContent).toBe('完成')
    // The next run starts live: the held icon leaves as the comet comes in.
    await screen.rerender(row(1, 'running'))
    expect(glyph().querySelector('.ui-status-glyph-leaving .lucide-terminal')).not.toBeNull()
    expect(glyph().querySelector('.ui-status-glyph-current .ui-comet-drift')).not.toBeNull()
    // A switch of session or a resynchronization shows the new state at once.
    await screen.rerender(row(2, 'completed'))
    expect([
      glyph().hasAttribute('data-shift'),
      glyph().querySelector('.ui-status-glyph-leaving'),
      words().hasAttribute('data-shift'),
    ]).toEqual([false, null, false])
    await frames()
    expect([...glyph().getAnimations({ subtree: true }), ...words().getAnimations()]).toEqual([])
  })

  it('cross-fades a plan step’s still mark when its state changes live', async () => {
    const screen = await render(step(1, 'pending'))
    const glyph = () => screen.container.querySelector('.ui-status-glyph')!
    await screen.rerender(step(1, 'in_progress'))
    expect([
      glyph().querySelector('.ui-status-glyph-leaving .lucide-circle') !== null,
      glyph().querySelector('.ui-status-glyph-current .lucide-circle-dot') !== null,
    ]).toEqual([true, true])
    await screen.rerender(step(1, 'completed'))
    expect([
      glyph().querySelector('.ui-status-glyph-leaving .lucide-circle-dot') !== null,
      glyph().querySelector('.ui-status-glyph-current .lucide-check') !== null,
    ]).toEqual([true, true])
    // No comet anywhere: a plan step is a still mark.
    expect(glyph().querySelector('.ui-comet')).toBeNull()
  })

  it('starts no animation at all when motion is reduced, and its still frames still read', async () => {
    await protocol().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    try {
      const screen = await render(scene(1, 'running'))
      await screen.rerender(scene(2, 'unread', 'completed'))
      await screen.rerender(scene(3, 'time', 'running'))
      await expect.poll(() => screen.container.querySelector('.ui-comet[data-relay]')).not.toBeNull()
      await frames()
      expect(document.getAnimations()).toEqual([])
      // The comet keeps its track and its head; the pill its amber; the count and the slot show the new values.
      expect(screen.getByRole('img', { name: '运行中' }).element().querySelector('circle')).not.toBeNull()
      expect(screen.container.querySelector('.ui-count')?.textContent).toBe('3')
      expect(
        screen.container.querySelector('.ui-count-roll, .ui-count-ripple, .ui-status-leaving, .ui-status-glyph-leaving, [data-shift]'),
      ).toBeNull()
      expect(screen.container.querySelector('.ui-status-slot')?.textContent).toBe('09:15')
    } finally {
      await protocol().send('Emulation.setEmulatedMedia', { features: [] })
    }
  })
})
