import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { Check, Circle, CircleDot, Terminal } from 'lucide-react'
import {
  Count,
  Icon,
  LiveChanges,
  Spinner,
  StatusGlyph,
  StatusPill,
  StatusSlot,
  StatusWord,
  StatusWords,
  useLivePrevious,
  type SlotStatus,
} from '../src/index.ts'
import { protocol } from './helpers.ts'

const frames = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
const pause = (ms: number) => new Promise(done => setTimeout(done, ms))

/** The CSS animation running on `element`, if any. */
function animation(element: Element): CSSAnimation | undefined {
  return element.getAnimations().find((item): item is CSSAnimation => item instanceof CSSAnimation)
}
/** The duration and curve an element animates with. */
function timing(element: Element): { duration: string; easing: string } {
  const style = getComputedStyle(element)
  return { duration: style.animationDuration, easing: style.animationTimingFunction }
}
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** Emulates `prefers-reduced-motion: reduce` for the duration of `run`. */
async function reducedMotion(run: () => Promise<void>): Promise<void> {
  await protocol().send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  try {
    await run()
  } finally {
    await protocol().send('Emulation.setEmulatedMedia', { features: [] })
  }
}

/** `epoch` stands for the page's resynchronization epoch: a change made under a new epoch was not seen live. */
function Live({ epoch, children }: { epoch: number; children: ReactNode }) {
  return <LiveChanges value={epoch}>{children}</LiveChanges>
}

const slot = (epoch: number, status: SlotStatus) => (
  <Live epoch={epoch}>
    <StatusSlot status={status} time="2 分钟" />
  </Live>
)

/** A row that shows its waiting count only above zero, as the sidebar's 等你处理 row does. */
function Waiting({ value }: { value: number }) {
  const before = useLivePrevious(value)
  return <div>{value > 0 && <Count value={value} tone="warn" from={before} />}</div>
}

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

describe('status words', () => {
  it('says a state in 12/16·500 words with tabular digits, after its 12px glyph in the colour of what it means', async () => {
    const screen = await render(
      <div>
        <StatusWord tone="waiting">等你处理</StatusWord>
        <StatusWord tone="running">运行中 1:12</StatusWord>
        <StatusWord tone="failed">失败</StatusWord>
        <StatusWord tone="done">已完成</StatusWord>
        <StatusWord tone="warn">不可用</StatusWord>
        <StatusWord>已取消</StatusWord>
      </div>,
    )
    const words = Array.from(screen.container.querySelectorAll<HTMLElement>('.ui-status-word'))
    const style = (element: Element) => getComputedStyle(element)
    expect(words.map(item => [item.textContent, style(item).color])).toEqual([
      ['等你处理', 'rgb(180, 83, 9)'],
      ['运行中 1:12', 'rgb(24, 24, 27)'],
      ['失败', 'rgb(185, 28, 28)'],
      ['已完成', 'rgb(24, 24, 27)'],
      ['不可用', 'rgb(180, 83, 9)'],
      ['已取消', 'rgb(113, 113, 122)'],
    ])
    expect(
      words.every(item => style(item).fontSize === '12px' && style(item).lineHeight === '16px' && style(item).fontWeight === '500'),
    ).toBe(true)
    expect(style(words[1]!).fontVariantNumeric).toBe('tabular-nums')
    // Waiting has the shield in the amber of icons, running the spinner, failed circle-alert, done a check; the rest none.
    const glyph = (index: number) => words[index]!.querySelector('.ui-status-word-glyph')
    expect(glyph(0)?.classList.contains('lucide-shield')).toBe(true)
    expect(style(glyph(0)!).color).toBe('rgb(245, 158, 11)')
    expect(glyph(1)?.classList.contains('ui-spinner')).toBe(true)
    expect(glyph(1)?.getAttribute('data-size')).toBe('12')
    expect(glyph(2)?.classList.contains('lucide-circle-alert')).toBe(true)
    expect(glyph(3)?.classList.contains('lucide-check')).toBe(true)
    expect([glyph(4), glyph(5)]).toEqual([null, null])
    // Glyphs are decorative: the words say the state.
    expect(
      words.flatMap(item => Array.from(item.querySelectorAll('svg, .ui-spinner'), element => element.getAttribute('aria-hidden'))),
    ).toEqual(Array(4).fill('true'))
  })

  it('draws a StatusPill as a status word without a pill, red with circle-alert for a risk', async () => {
    const screen = await render(
      <div>
        <StatusPill>已取消</StatusPill>
        <StatusPill tone="err">高风险</StatusPill>
      </div>,
    )
    const [neutral, risk] = Array.from(screen.container.querySelectorAll<HTMLElement>('.ui-status-word'))
    expect([neutral?.dataset.tone, risk?.dataset.tone]).toEqual(['neutral', 'failed'])
    expect(getComputedStyle(risk!).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    expect(risk?.querySelector('.lucide-circle-alert')).not.toBeNull()
  })
})

describe('the spinner', () => {
  it('is a ring of its colour at 22% with one full quarter, 12 to 20 wide, turning once every 800ms', async () => {
    const screen = await render(
      <div style={{ color: 'rgb(24, 24, 27)' }}>
        <Spinner size={12} />
        <Spinner size={14} />
        <Spinner size={16} />
        <Spinner size={20} />
      </div>,
    )
    const spinners = Array.from(screen.container.querySelectorAll<HTMLElement>('.ui-spinner'))
    // The box, not its turning bounds.
    expect(spinners.map(item => item.offsetWidth)).toEqual([12, 14, 16, 20])
    const style = getComputedStyle(spinners[0]!)
    expect([style.borderTopColor, style.borderRightColor]).toEqual(['rgb(24, 24, 27)', 'color(srgb 0.0941176 0.0941176 0.105882 / 0.22)'])
    // 1.5px (whole device pixels at a ratio of 1), and 2px at 20.
    expect(parseFloat(style.borderTopWidth)).toBeGreaterThanOrEqual(1)
    expect(getComputedStyle(spinners[3]!).borderTopWidth).toBe('2px')
    const turn = animation(spinners[0]!)
    expect([turn?.animationName, turn?.effect?.getTiming().duration, turn?.effect?.getTiming().iterations]).toEqual([
      'ui-spin',
      800,
      Infinity,
    ])
    expect(spinners.every(item => item.getAttribute('aria-hidden') === 'true')).toBe(true)
  })

  it('turns every spinner on the page in one phase, whenever it mounted', async () => {
    const first = await render(<Spinner size={12} />)
    await pause(130)
    const second = await render(<Spinner size={12} />)
    await frames()
    const progress = (element: Element) => animation(element)?.effect?.getComputedTiming().progress ?? Number.NaN
    const [a, b] = [first, second].map(screen => progress(screen.container.querySelector('.ui-spinner')!))
    const apart = Math.min(Math.abs(a! - b!), 1 - Math.abs(a! - b!))
    expect(apart).toBeLessThan(0.05)
  })

  it('pauses out of view and stops on its still frame under reduced motion', async () => {
    const screen = await render(
      <div style={{ height: 80, overflow: 'auto' }} data-testid="scroller">
        <div style={{ height: 400 }} />
        <Spinner size={12} />
      </div>,
    )
    const spinner = screen.container.querySelector<HTMLElement>('.ui-spinner')!
    await expect.poll(() => spinner.hasAttribute('data-offscreen')).toBe(true)
    await expect.poll(() => animation(spinner)?.playState).toBe('paused')
    screen.getByTestId('scroller').element().scrollTop = 400
    await expect.poll(() => animation(spinner)?.playState).toBe('running')
    await reducedMotion(async () => {
      await pause(50)
      expect(spinner.getAnimations()).toHaveLength(0)
      // The still frame still reads as waiting: the faint ring with its full quarter.
      expect(getComputedStyle(spinner).borderTopColor).not.toBe(getComputedStyle(spinner).borderRightColor)
    })
  })
})

describe('the status slot', () => {
  it('shows one thing per status in the vocabulary: 运行中, 等你处理, 失败, the unread check or the time', async () => {
    const screen = await render(
      <div>
        <StatusSlot status="running" />
        <StatusSlot status="waiting" />
        <StatusSlot status="failed" />
        <StatusSlot status="unread" />
        <StatusSlot status="time" time="周三" dateTime="2026-10-21T09:15:00+08:00" />
        <StatusSlot status="none" time="09:15" />
        <StatusSlot status="failed" failed="权限已变化" />
        <StatusSlot status="running" running="运行中 1:12" />
      </div>,
    )
    const slots = Array.from(screen.container.querySelectorAll('.ui-status-slot'))
    expect(slots.map(item => item.getAttribute('aria-hidden'))).toEqual(Array(8).fill('true'))
    expect(slots.map(item => item.textContent)).toEqual(['运行中', '等你处理', '失败', '', '周三', '', '权限已变化', '运行中 1:12'])
    expect(slots.map(item => item.querySelector('.ui-status-word')?.getAttribute('data-tone') ?? null)).toEqual([
      'running',
      'waiting',
      'failed',
      null,
      null,
      null,
      'failed',
      'running',
    ])
    // Unread is a 12px ink check; the time is faint, at the regular weight.
    const check = slots[3]?.querySelector('.ui-status-unread')
    expect(check?.classList.contains('lucide-check')).toBe(true)
    expect(getComputedStyle(check!).color).toBe('rgb(24, 24, 27)')
    const time = slots[4]?.querySelector('time')
    expect([time?.getAttribute('dateTime'), getComputedStyle(time!).color, getComputedStyle(time!).fontWeight]).toEqual([
      '2026-10-21T09:15:00+08:00',
      'rgb(161, 161, 170)',
      '400',
    ])
  })

  it('cross-fades a change of status over --m-micro, only when the page saw it happen', async () => {
    const screen = await render(slot(1, 'running'))
    const element = () => screen.container.querySelector('.ui-status-slot')!
    expect(element().hasAttribute('data-shift')).toBe(false)
    await screen.rerender(slot(1, 'unread'))
    expect(element().hasAttribute('data-shift')).toBe(true)
    const leaving = element().querySelector('.ui-status-leaving')!
    const shown = element().querySelector('.ui-status-shown')!
    expect(leaving.querySelector('.ui-status-word[data-tone="running"]')).not.toBeNull()
    expect(shown.querySelector('.ui-status-unread')).not.toBeNull()
    expect([animation(leaving)?.animationName, animation(shown)?.animationName]).toEqual(['ui-fade-out', 'ui-fade-in'])
    expect([timing(leaving), timing(shown)]).toEqual([
      { duration: '0.084s', easing: token('--e-exit') },
      { duration: '0.12s', easing: token('--e-micro') },
    ])
    await screen.rerender(slot(1, 'time'))
    expect(element().querySelector('.ui-status-shown > .ui-status-time')).not.toBeNull()
    // A switch of session or a resynchronization changes the slot at once.
    await screen.rerender(slot(2, 'running'))
    await screen.rerender(slot(3, 'waiting'))
    expect([element().hasAttribute('data-shift'), element().querySelector('.ui-status-leaving')]).toEqual([false, null])
    // Without an epoch from the page nothing is known to be live.
    const bare = await render(<StatusSlot status="running" />)
    await bare.rerender(<StatusSlot status="unread" />)
    expect(bare.container.querySelector('.ui-status-slot')?.hasAttribute('data-shift')).toBe(false)
  })
})

describe('counts', () => {
  it('writes tabular digits in the tone of what they count, and caps them at 99+', async () => {
    const screen = await render(
      <div>
        <Count value={3} />
        <Count value={12} tone="strong" />
        <Count value={128} tone="warn" />
      </div>,
    )
    const counts = Array.from(screen.container.querySelectorAll<HTMLElement>('.ui-count'))
    expect(counts.map(item => item.textContent)).toEqual(['3', '12', '99+'])
    expect(counts.map(item => getComputedStyle(item).color).slice(1)).toEqual(['rgb(24, 24, 27)', 'rgb(180, 83, 9)'])
    expect(getComputedStyle(counts[0]!).fontVariantNumeric).toBe('tabular-nums')
    expect(getComputedStyle(counts[0]!).backgroundColor).toBe('rgba(0, 0, 0, 0)')
  })

  it('fades a new number in only for a change seen live, the first arrival of a count shown above zero too', async () => {
    const count = (epoch: number, value: number) => (
      <Live epoch={epoch}>
        <Count value={value} tone="warn" />
      </Live>
    )
    const screen = await render(count(1, 2))
    const element = () => screen.container.querySelector('.ui-count')!
    expect(element().hasAttribute('data-shift')).toBe(false)
    await screen.rerender(count(2, 3))
    expect([element().hasAttribute('data-shift'), element().textContent]).toEqual([false, '3'])
    await screen.rerender(count(2, 4))
    expect([element().hasAttribute('data-shift'), animation(element())?.animationName]).toEqual([true, 'ui-fade-in'])

    const arrival = (epoch: number, value: number) => (
      <Live epoch={epoch}>
        <Waiting value={value} />
      </Live>
    )
    const rows = await render(arrival(1, 0))
    const shown = () => rows.container.querySelector('.ui-count')
    expect(shown()).toBeNull()
    await rows.rerender(arrival(1, 1))
    expect(shown()?.hasAttribute('data-shift')).toBe(true)
    // 0 → 1 that arrives with a resynchronization just shows.
    await rows.rerender(arrival(1, 0))
    await rows.rerender(arrival(2, 1))
    expect(shown()?.hasAttribute('data-shift')).toBe(false)
  })
})

describe('process rows', () => {
  it('runs the spinner in a process row and cross-fades it into the row’s icon over --m-micro, only for a change seen live', async () => {
    const screen = await render(row(1, 'running'))
    const glyph = () => screen.container.querySelector('.ui-status-glyph')!
    const words = () => screen.container.querySelector('.ui-status-words')!
    expect([glyph().hasAttribute('data-shift'), words().hasAttribute('data-shift')]).toEqual([false, false])
    expect(glyph().querySelector('.ui-status-glyph-current .ui-spinner[data-size="14"]')).not.toBeNull()
    expect(glyph().getAttribute('aria-hidden')).toBe('true')
    await screen.rerender(row(1, 'completed'))
    const leaving = glyph().querySelector('.ui-status-glyph-leaving')!
    const current = glyph().querySelector('.ui-status-glyph-current')!
    expect(leaving.querySelector('.ui-spinner')).not.toBeNull()
    expect(current.querySelector('.lucide-terminal')).not.toBeNull()
    expect([animation(leaving)?.animationName, animation(current)?.animationName, animation(words())?.animationName]).toEqual([
      'ui-fade-out',
      'ui-swap-in',
      'ui-fade-in',
    ])
    expect([timing(leaving), timing(current), timing(words())]).toEqual([
      { duration: '0.084s', easing: token('--e-exit') },
      { duration: '0.12s', easing: token('--e-micro') },
      { duration: '0.12s', easing: token('--e-micro') },
    ])
    expect(words().textContent).toBe('完成')
    // A switch of session or a resynchronization shows the new state at once.
    await screen.rerender(row(2, 'running'))
    expect([
      glyph().hasAttribute('data-shift'),
      glyph().querySelector('.ui-status-glyph-leaving'),
      words().hasAttribute('data-shift'),
    ]).toEqual([false, null, false])
  })

  it('cross-fades a plan step’s still mark when its state changes live, with no spinner', async () => {
    const screen = await render(step(1, 'pending'))
    const glyph = () => screen.container.querySelector('.ui-status-glyph')!
    await screen.rerender(step(1, 'in_progress'))
    expect([
      glyph().querySelector('.ui-status-glyph-leaving .lucide-circle') !== null,
      glyph().querySelector('.ui-status-glyph-current .lucide-circle-dot') !== null,
    ]).toEqual([true, true])
    await screen.rerender(step(1, 'completed'))
    expect(glyph().querySelector('.ui-status-glyph-current .lucide-check')).not.toBeNull()
    expect(glyph().querySelector('.ui-spinner')).toBeNull()
  })
})

it('animates nothing under reduced motion: changes show at once and every still frame reads', async () => {
  await reducedMotion(async () => {
    const scene = (epoch: number, status: SlotStatus, value: number, state: ProcessState) => (
      <Live epoch={epoch}>
        <StatusWord tone="running">运行中</StatusWord>
        <StatusSlot status={status} time="2 分钟" />
        <Count value={value} tone="warn" />
        <StatusGlyph running={state === 'running'}>
          <Icon icon={Terminal} size={14} />
        </StatusGlyph>
        <StatusWords state={state}>{state}</StatusWords>
      </Live>
    )
    const screen = await render(scene(1, 'running', 1, 'running'))
    await screen.rerender(scene(1, 'unread', 2, 'completed'))
    await screen.rerender(scene(1, 'time', 3, 'running'))
    await frames()
    expect(document.getAnimations()).toEqual([])
    expect(screen.container.querySelector('.ui-status-leaving, .ui-status-glyph-leaving, [data-shift]')).toBeNull()
    expect(screen.container.querySelector('.ui-status-slot')?.textContent).toBe('2 分钟')
    expect(screen.container.querySelector('.ui-count')?.textContent).toBe('3')
    expect(screen.container.querySelector('.ui-status-word .ui-spinner')).not.toBeNull()
  })
})
