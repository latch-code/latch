import { Profiler } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { Button, ChecksBar, Fact, KeyHint, LiveDot, SectionTitle, StatusStrip, TickFrame } from '../src/index.ts'
import { keyHintWatchers } from '../src/facts.tsx'
import { emulateMedia } from './helpers.ts'

const key = (type: 'keydown' | 'keyup', name: string) => window.dispatchEvent(new KeyboardEvent(type, { key: name, bubbles: true }))

/** The mono face as the browser writes a font family back. */
function mono(): string {
  const probe = document.createElement('code')
  document.body.append(probe)
  const family = getComputedStyle(probe).fontFamily
  probe.remove()
  return family
}

afterEach(() => {
  // No key is left held for the next test.
  window.dispatchEvent(new Event('blur'))
})

describe('facts', () => {
  it('sets a fact in the mono face with tabular figures, and colours only added and removed lines', async () => {
    const screen = await render(
      <p>
        <Fact>1:12</Fact>
        <Fact tone="add">+61</Fact>
        <Fact tone="del">−4</Fact>
      </p>,
    )
    const [plain, added, removed] = [...screen.container.querySelectorAll('.ui-fact')].map(fact => getComputedStyle(fact))
    expect(plain!.fontFamily).toBe(mono())
    expect([plain!.fontVariantNumeric, plain!.fontSize, plain!.lineHeight]).toEqual(['tabular-nums', '12px', '18px'])
    expect(plain!.color).toBe(getComputedStyle(screen.container.querySelector('p')!).color)
    expect(added!.color).not.toBe(plain!.color)
    expect(removed!.color).not.toBe(added!.color)
  })
})

describe('the checks of a pull request', () => {
  it('draws one segment per check: passed, failed, then the rest, and says so to a screen reader', async () => {
    const screen = await render(<ChecksBar passed={3} failed={1} total={6} />)
    const bar = screen.getByRole('img').element()
    expect(bar.getAttribute('aria-label')).toBe('检查 3/6 通过，1 项失败')
    expect([...bar.children].map(segment => segment.getAttribute('data-state'))).toEqual([
      'passed',
      'passed',
      'passed',
      'failed',
      null,
      null,
    ])
    const [passed, , , failed, rest] = [...bar.children].map(segment => getComputedStyle(segment).backgroundColor)
    expect(new Set([passed, failed, rest]).size).toBe(3)
    // Nothing in it moves.
    expect(bar.getAnimations({ subtree: true })).toEqual([])
  })

  it('draws nothing without real counts', async () => {
    const screen = await render(
      <div>
        <ChecksBar passed={0} total={0} />
        <ChecksBar passed={2.5} total={6} />
        <ChecksBar passed={-1} total={6} />
        <ChecksBar passed={5} failed={3} total={6} />
        <ChecksBar passed={Number.NaN} total={6} />
        <ChecksBar passed={20} total={40} />
      </div>,
    )
    expect(screen.container.querySelector('.ui-checks')).toBeNull()
    expect(screen.container.firstElementChild!.childElementCount).toBe(0)
  })
})

describe('the status strip', () => {
  it('renders the facts it is given, in order, and nothing of its own', async () => {
    const screen = await render(
      <StatusStrip
        label="连接"
        facts={[
          { id: 'computer', text: 'MacBook Pro', lead: <LiveDot live /> },
          { id: 'link', text: 'host.sock' },
          { id: 'blank', text: '  ' },
          { id: 'palette', text: '⌘K', end: true },
        ]}
      />,
    )
    const strip = screen.getByRole('group', { name: '连接' }).element()
    expect([...strip.children].map(fact => fact.textContent)).toEqual(['MacBook Pro', 'host.sock', '⌘K'])
    expect(strip.textContent).toBe('MacBook Prohost.sock⌘K')
    const style = getComputedStyle(strip)
    expect([style.fontFamily, style.fontVariantNumeric, style.height]).toEqual([mono(), 'tabular-nums', '26px'])
    // The fact at the end is pushed to the far edge.
    const last = strip.lastElementChild!.getBoundingClientRect()
    expect(strip.getBoundingClientRect().right - last.right).toBeLessThanOrEqual(17)
  })

  it('is not there without a fact', async () => {
    const screen = await render(
      <div>
        <StatusStrip label="连接" facts={[]} />
        <StatusStrip label="连接" facts={[{ id: 'blank', text: '' }]} />
      </div>,
    )
    expect(screen.container.firstElementChild!.childElementCount).toBe(0)
  })
})

describe("a section's title", () => {
  it('is a heading with its count as a fact and an action at the end, over a rule', async () => {
    const screen = await render(<SectionTitle title="进行中" count={3} action={<Button size="xs">全部会话</Button>} />)
    const heading = screen.getByRole('heading', { level: 2, name: '进行中' }).element()
    const title = heading.parentElement!
    expect(title.querySelector('.ui-section-title-count')!.textContent).toBe('3')
    expect(getComputedStyle(title.querySelector('.ui-section-title-count')!).fontVariantNumeric).toBe('tabular-nums')
    const rule = getComputedStyle(title, '::after')
    expect([rule.height, rule.position]).toEqual(['1px', 'absolute'])
    const action = screen.getByRole('button', { name: '全部会话' }).element().getBoundingClientRect()
    expect(Math.round(title.getBoundingClientRect().right - action.right)).toBe(0)
  })

  it('goes faint at zero and shows no count while the number is not known', async () => {
    const screen = await render(
      <div>
        <SectionTitle title="可交付" count={0} level={3} />
        <SectionTitle title="进行中" />
      </div>,
    )
    const [zero, unknown] = [...screen.container.querySelectorAll('.ui-section-title')]
    expect(zero!.hasAttribute('data-zero')).toBe(true)
    expect(zero!.querySelector('h3')).not.toBeNull()
    expect(getComputedStyle(zero!).color).not.toBe(getComputedStyle(unknown!).color)
    expect(unknown!.querySelector('.ui-section-title-count')).toBeNull()
  })
})

describe('corner ticks', () => {
  it('stand outside the four corners of the frame the keys act on, as decoration', async () => {
    const screen = await render(
      <TickFrame on style={{ width: 200, height: 60, margin: 20 }}>
        <span>写入 docs/settings.md</span>
      </TickFrame>,
    )
    const frame = screen.container.querySelector('.ui-tick-frame')!.getBoundingClientRect()
    const ticks = screen.container.querySelector('.ui-ticks')!
    expect(ticks.getAttribute('aria-hidden')).toBe('true')
    expect(getComputedStyle(ticks).pointerEvents).toBe('none')
    const corners = [...ticks.children].map(tick => tick.getBoundingClientRect())
    expect(corners).toHaveLength(4)
    expect(corners.map(corner => [corner.width, corner.height])).toEqual(Array.from({ length: 4 }, () => [9, 9]))
    // Each tick is 7px outside its corner; none overlaps the frame's content box.
    expect([corners[0]!.left, corners[0]!.top]).toEqual([frame.left - 7, frame.top - 7])
    expect([corners[3]!.right, corners[3]!.bottom]).toEqual([frame.right + 7, frame.bottom + 7])
  })

  it('are absent when the keys act elsewhere, and close in once when the target lands', async () => {
    const screen = await render(
      <div>
        <TickFrame on={false}>
          <span>核对</span>
        </TickFrame>
        <TickFrame on lock>
          <span>写入</span>
        </TickFrame>
      </div>,
    )
    const [off, locking] = [...screen.container.querySelectorAll('.ui-tick-frame')]
    expect(off!.querySelector('.ui-ticks')).toBeNull()
    const tick = () => getComputedStyle(locking!.querySelector('.ui-ticks > i')!)
    expect([tick().animationName, tick().animationDuration, tick().animationIterationCount]).toEqual(['ui-tick-lock', '0.26s', '1'])
    // They close in after the target has landed: a delay from the motion tokens, not a number of its own.
    expect(tick().animationDelay).toBe(`${parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--m-enter')) / 1000}s`)
    await emulateMedia({ 'prefers-reduced-motion': 'reduce' }, () => {
      expect(tick().animationName).toBe('none')
    })
  })
})

describe('a key hint', () => {
  it('lights each key only while that key is down', async () => {
    const screen = await render(<KeyHint keys={['mod', 'enter']} />)
    const keys = () => [...screen.container.querySelectorAll('.ui-key-hint-key')].map(item => item.hasAttribute('data-down'))
    expect(keys()).toEqual([false, false])
    key('keydown', 'Meta')
    await expect.poll(keys).toEqual([true, false])
    key('keydown', 'Enter')
    await expect.poll(keys).toEqual([true, true])
    key('keyup', 'Enter')
    await expect.poll(keys).toEqual([true, false])
    // Ctrl is the same key as ⌘ here, as `mod` is the platform's command key.
    key('keyup', 'Meta')
    await expect.poll(keys).toEqual([false, false])
    key('keydown', 'Control')
    await expect.poll(keys).toEqual([true, false])
  })

  it('lets go of every key when ⌘ is released or the window loses focus', async () => {
    const screen = await render(<KeyHint keys={['mod', '1']} />)
    const keys = () => [...screen.container.querySelectorAll('.ui-key-hint-key')].map(item => item.hasAttribute('data-down'))
    key('keydown', 'Meta')
    key('keydown', '1')
    await expect.poll(keys).toEqual([true, true])
    // macOS sends no keyup for a key released while ⌘ is held.
    key('keyup', 'Meta')
    await expect.poll(keys).toEqual([false, false])
    key('keydown', '1')
    await expect.poll(keys).toEqual([false, true])
    window.dispatchEvent(new Event('blur'))
    await expect.poll(keys).toEqual([false, false])
  })

  it('renders a hint again only for its own keys, and lets go of the window with the last hint', async () => {
    // Commits of the subtree that holds the hint for 1.
    let renders = 0
    const added: string[] = []
    const removed: string[] = []
    const add = window.addEventListener.bind(window)
    const remove = window.removeEventListener.bind(window)
    window.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type)
      return (add as (...args: unknown[]) => void)(type, ...rest)
    }) as typeof window.addEventListener
    window.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type)
      return (remove as (...args: unknown[]) => void)(type, ...rest)
    }) as typeof window.removeEventListener
    try {
      expect(keyHintWatchers()).toBe(0)
      const screen = await render(
        <div>
          <KeyHint keys={['mod', 'enter']} />
          <Profiler id="one" onRender={() => renders++}>
            <KeyHint keys={['1']} />
          </Profiler>
        </div>,
      )
      const settled = renders
      const mine = () => screen.container.querySelectorAll('.ui-key-hint-key')[2]!.hasAttribute('data-down')
      // Keys this hint does not show leave it alone.
      key('keydown', 'Meta')
      key('keydown', 'a')
      await expect.poll(() => screen.container.querySelector('.ui-key-hint-key')!.hasAttribute('data-down')).toBe(true)
      expect(renders).toBe(settled)
      key('keydown', '1')
      await expect.poll(mine).toBe(true)
      expect(renders).toBeGreaterThan(settled)
      await screen.unmount()
      expect(keyHintWatchers()).toBe(0)
      // What was added to the window was taken off it again.
      const count = (list: string[], type: string) => list.filter(item => item === type).length
      for (const type of ['keydown', 'keyup', 'blur']) {
        expect(count(added, type), type).toBeGreaterThan(0)
        expect(count(removed, type), type).toBe(count(added, type))
      }
    } finally {
      window.addEventListener = add
      window.removeEventListener = remove
    }
  })

  it('is quiet mono without a box at rest and ink on the press fill while down; it performs nothing', async () => {
    let pressed = 0
    const screen = await render(
      <Button onClick={() => pressed++}>
        允许
        <KeyHint keys={['1']} />
      </Button>,
    )
    const hint = screen.container.querySelector('.ui-key-hint-key')!
    const rest = getComputedStyle(hint)
    expect([rest.backgroundColor, rest.borderTopWidth, rest.boxShadow]).toEqual(['rgba(0, 0, 0, 0)', '0px', 'none'])
    const quiet = rest.color
    key('keydown', '1')
    await expect.poll(() => hint.hasAttribute('data-down')).toBe(true)
    // The fill and the ink change over 80ms.
    await expect.poll(() => getComputedStyle(hint).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
    await expect.poll(() => getComputedStyle(hint).color).not.toBe(quiet)
    expect(getComputedStyle(hint).transitionDuration).toBe('0.08s, 0.08s')
    expect(pressed).toBe(0)
  })
})
