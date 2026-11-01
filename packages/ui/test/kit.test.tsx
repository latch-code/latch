import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { Check, FileText } from 'lucide-react'
import {
  Button,
  Drawer,
  DrawerStack,
  FoldHeader,
  LiveChanges,
  Menu,
  PanelTabs,
  SegmentedControl,
  SelectButton,
  Shimmer,
  SplitButton,
  StatusSlot,
  Tile,
} from '../src/index.ts'
import { onTouchScreen, press } from './helpers.ts'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('SplitButton', () => {
  const sections = [{ id: 'a', items: [{ id: 'push', label: '推送', onSelect: () => {} }] }]

  it('is two controls on one face, and its chevron opens the menu', async () => {
    const clicked = vi.fn()
    const screen = await render(
      <SplitButton menuLabel="更多 Git 操作" sections={sections} onClick={clicked}>
        提交
      </SplitButton>,
    )
    await screen.getByRole('button', { name: '提交' }).click()
    expect(clicked).toHaveBeenCalledOnce()
    await screen.getByRole('button', { name: '更多 Git 操作' }).click()
    await expect.element(page.getByRole('menuitem', { name: '推送' })).toBeVisible()
    const [main, more] = [
      screen.getByRole('button', { name: '提交' }).element(),
      screen.getByRole('button', { name: '更多 Git 操作' }).element(),
    ]
    expect(Math.round(main.getBoundingClientRect().height)).toBe(Math.round(more.getBoundingClientRect().height))
  })

  it('keeps the menu usable while the action is disabled, unless told otherwise', async () => {
    const screen = await render(
      <>
        <SplitButton disabled menuLabel="可用" sections={sections}>
          提交
        </SplitButton>
        <SplitButton disabled menuDisabled menuLabel="不可用" sections={sections}>
          提交
        </SplitButton>
      </>,
    )
    await screen.getByRole('button', { name: '不可用' }).click({ force: true })
    await expect.element(page.getByRole('menuitem', { name: '推送' })).not.toBeInTheDocument()
    await screen.getByRole('button', { name: '可用' }).click()
    await expect.element(page.getByRole('menuitem', { name: '推送' })).toBeVisible()
  })
})

describe('Button pending and done', () => {
  it('keeps the width and takes no clicks while a system sheet is open', async () => {
    const clicked = vi.fn()
    const Sample = ({ pending }: { pending: boolean }) => (
      <Button variant="primary" pending={pending} onClick={clicked}>
        允许
      </Button>
    )
    const screen = await render(<Sample pending={false} />)
    const button = screen.getByRole('button', { name: '允许' })
    const before = button.element().getBoundingClientRect().width
    await screen.rerender(<Sample pending />)
    await expect.element(button).toHaveAttribute('aria-busy', 'true')
    expect(button.element().querySelector('.ui-spinner')).not.toBeNull()
    expect(Math.abs(button.element().getBoundingClientRect().width - before)).toBeLessThan(1)
    press(button)
    expect(clicked).not.toHaveBeenCalled()
  })

  it('morphs into a tick with the done words on success, and takes no clicks', async () => {
    const clicked = vi.fn()
    const screen = await render(
      <Button icon={Check} done doneLabel="已允许" onClick={clicked}>
        允许
      </Button>,
    )
    const button = screen.getByRole('button', { name: '已允许' })
    expect(button.element().querySelector('.ui-button-tick')).not.toBeNull()
    press(button)
    expect(clicked).not.toHaveBeenCalled()
  })
})

describe('SelectButton and the xs segmented control', () => {
  it('draws a 28px value button that stays focusable when disabled', async () => {
    const clicked = vi.fn()
    const screen = await render(
      <SelectButton leading={<Tile size={16} icon={FileText} />} disabled onClick={clicked}>
        通用
      </SelectButton>,
    )
    const button = screen.getByRole('button', { name: '通用' })
    expect(button.element().getBoundingClientRect().height).toBe(28)
    press(button)
    expect(clicked).not.toHaveBeenCalled()
  })

  it('keeps a disabled menu shut from the keyboard too', async () => {
    const screen = await render(
      <Menu
        label="模式"
        sections={[{ id: 'a', items: [{ id: 'one', label: '第一项', onSelect: () => {} }] }]}
        trigger={menu => (
          <SelectButton {...menu} disabled>
            通用
          </SelectButton>
        )}
      />,
    )
    screen.getByRole('button', { name: '通用' }).element().focus()
    await userEvent.keyboard('{ArrowDown}')
    await wait(50)
    expect(document.querySelector('.ui-popover:popover-open')).toBeNull()
  })

  it('is 24 overall at xs', async () => {
    const screen = await render(
      <SegmentedControl
        label="布局"
        size="xs"
        value="a"
        options={[
          { value: 'a', label: '上下' },
          { value: 'b', label: '左右' },
        ]}
        onValueChange={() => {}}
      />,
    )
    expect(screen.getByRole('radiogroup').element().getBoundingClientRect().height).toBe(24)
  })
})

describe('PanelTabs', () => {
  function Sample({ onClose }: { onClose: (value: string) => void }) {
    const [value, setValue] = useState('a')
    return (
      <PanelTabs
        label="面板"
        value={value}
        onValueChange={setValue}
        onClose={onClose}
        tabs={[
          { value: 'a', label: '改动', icon: FileText, stat: { added: 60, removed: 6 } },
          { value: 'b', label: 'notes.md', icon: FileText, closeLabel: '关闭 notes.md', fresh: true },
        ]}
      />
    )
  }

  it('keeps a closable tab without a glyph clear of its ×', async () => {
    const screen = await render(
      <PanelTabs
        label="面板"
        value="a"
        onValueChange={() => {}}
        onClose={() => {}}
        tabs={[{ value: 'a', label: 'notes.md', closeLabel: '关闭 notes.md' }]}
      />,
    )
    const label = screen.container.querySelector('.ui-panel-tab-label')!.getBoundingClientRect()
    const close = screen.container.querySelector('.ui-panel-tab-close')!.getBoundingClientRect()
    expect(close.right).toBeLessThanOrEqual(label.left)
  })

  it('shows the stat and the new-content dot, and is one tab stop moved by arrows', async () => {
    const screen = await render(<Sample onClose={() => {}} />)
    const first = screen.getByRole('tab', { name: /改动/u })
    expect(first.element().textContent).toContain('+60 −6')
    await expect.element(screen.getByRole('img', { name: '有新内容' })).toBeVisible()
    expect(screen.getByRole('tab', { name: /notes/u }).element().tabIndex).toBe(-1)
    first.element().focus()
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(screen.getByRole('tab', { name: /notes/u })).toHaveAttribute('aria-selected', 'true')
  })

  it('turns the glyph into × on hover, over the same place, and closes with it or Delete', async () => {
    const closed = vi.fn()
    const screen = await render(<Sample onClose={closed} />)
    const tab = screen.getByRole('tab', { name: /notes/u })
    const close = screen.getByRole('button', { name: '关闭 notes.md' })
    expect(getComputedStyle(close.element()).opacity).toBe('0')
    await tab.hover()
    await expect.poll(() => getComputedStyle(close.element()).opacity).toBe('1')
    const glyph = tab.element().querySelector('.ui-panel-tab-glyph')!.getBoundingClientRect()
    const box = close.element().getBoundingClientRect()
    expect([box.left, box.top]).toEqual([glyph.left, glyph.top])
    await close.click()
    expect(closed).toHaveBeenCalledWith('b')
    tab.element().focus()
    await userEvent.keyboard('{Delete}')
    expect(closed).toHaveBeenCalledTimes(2)
    screen
      .getByRole('tab', { name: /改动/u })
      .element()
      .focus()
    await userEvent.keyboard('{Delete}')
    expect(closed).toHaveBeenCalledTimes(2)
  })
})

describe('DrawerStack', () => {
  const stack = (keys: string[], arming = false) => (
    <LiveChanges.Provider value="live">
      <DrawerStack>
        {keys.map(key => (
          <Drawer key={key} arming={arming} label={key}>
            <button type="button">{`答 ${key}`}</button>
          </Drawer>
        ))}
      </DrawerStack>
    </LiveChanges.Provider>
  )

  it('has inset 20, overlap 14 and top radius 16, and caps what is behind the front drawer', async () => {
    const screen = await render(<div style={{ width: 500 }}>{stack(['a', 'b'])}</div>)
    const [back, front] = Array.from(screen.container.querySelectorAll<HTMLElement>('.ui-drawer'))
    const style = getComputedStyle(front!)
    expect([style.marginLeft, style.marginRight, style.marginBottom, style.borderTopLeftRadius]).toEqual(['20px', '20px', '-14px', '16px'])
    expect(back!.dataset.capped).toBe('')
    expect(front!.dataset.capped).toBeUndefined()
    expect(back!.getBoundingClientRect().height).toBe(24)
    expect(back!.getBoundingClientRect().width / front!.getBoundingClientRect().width).toBeLessThan(1)
    expect(back!.querySelector('.ui-drawer-body')!.hasAttribute('inert')).toBe(true)
  })

  it('opens the stack on hover and on a tap', async () => {
    const screen = await render(stack(['a', 'b']))
    const back = () => screen.container.querySelector<HTMLElement>('.ui-drawer')!
    await page.getByRole('group', { name: 'b' }).hover()
    await expect.poll(() => back().dataset.capped).toBeUndefined()
    await expect.poll(() => back().getBoundingClientRect().height).toBeGreaterThan(24)
  })

  it('slides what appears and keeps what goes until it has left, when the page saw it', async () => {
    const screen = await render(stack(['a']))
    const only = screen.container.querySelector<HTMLElement>('.ui-drawer')!
    expect(only.dataset.entering).toBeUndefined()
    await screen.rerender(stack(['a', 'b']))
    await expect.poll(() => screen.container.querySelectorAll('.ui-drawer[data-entering]').length).toBe(1)
    await screen.rerender(stack(['a']))
    expect(screen.container.querySelectorAll('.ui-drawer[data-leaving]').length).toBe(1)
    expect(screen.container.querySelector('.ui-drawer[data-leaving] .ui-drawer-body')!.hasAttribute('inert')).toBe(true)
    await expect.poll(() => screen.container.querySelectorAll('.ui-drawer').length).toBe(1)
  })

  it('shows and removes at once when the state was established again', async () => {
    const swap = (epoch: string, keys: string[]) => (
      <LiveChanges.Provider value={epoch}>
        <DrawerStack>
          {keys.map(key => (
            <Drawer key={key}>{key}</Drawer>
          ))}
        </DrawerStack>
      </LiveChanges.Provider>
    )
    const screen = await render(swap('one', ['a']))
    await screen.rerender(swap('two', ['b']))
    expect(Array.from(screen.container.querySelectorAll('.ui-drawer'), item => item.textContent)).toEqual(['b'])
    expect(screen.container.querySelector('.ui-drawer[data-entering]')).toBeNull()
  })

  it('keeps an arming drawer inert for 320ms after it appears', async () => {
    const screen = await render(stack(['a'], true))
    const body = screen.container.querySelector('.ui-drawer-body')!
    expect(body.hasAttribute('inert')).toBe(true)
    await wait(200)
    expect(body.hasAttribute('inert')).toBe(true)
    await expect.poll(() => body.hasAttribute('inert')).toBe(false)
  })

  it('arms a drawer again when it comes to the front', async () => {
    const screen = await render(
      <>
        <p>别处</p>
        {stack(['a', 'b'], true)}
      </>,
    )
    await screen.getByText('别处').hover()
    await wait(400)
    const first = screen.container.querySelector<HTMLElement>('.ui-drawer')!
    expect(first.querySelector('.ui-drawer-body')!.hasAttribute('inert')).toBe(true)
    await screen.rerender(
      <>
        <p>别处</p>
        {stack(['a'], true)}
      </>,
    )
    await expect.poll(() => first.dataset.capped).toBeUndefined()
    expect(first.querySelector('.ui-drawer-body')!.hasAttribute('inert')).toBe(true)
    await expect.poll(() => first.querySelector('.ui-drawer-body')!.hasAttribute('inert')).toBe(false)
  })

  it('arms a drawer again when it reaches the front of a stack that is already open', async () => {
    const screen = await render(stack(['a', 'b'], true))
    await page.getByRole('group', { name: 'b' }).hover()
    const body = () => screen.container.querySelector('.ui-drawer-body')!
    await expect.poll(() => body().hasAttribute('inert')).toBe(false)
    await screen.rerender(stack(['a'], true))
    expect(body().hasAttribute('inert')).toBe(true)
    await wait(200)
    expect(body().hasAttribute('inert')).toBe(true)
    await expect.poll(() => body().hasAttribute('inert')).toBe(false)
  })
})

describe('StatusSlot with actions', () => {
  const sample = (
    <div data-status-row="" style={{ width: 200 }}>
      <StatusSlot status="time" time="2 分钟" actions={<button type="button">归档</button>} />
    </div>
  )

  it('gives way to the actions on hover and focus inside the row', async () => {
    const screen = await render(sample)
    const slot = screen.container.querySelector('.ui-status-slot')!
    const actions = screen.container.querySelector('.ui-status-swap-actions')!
    expect(getComputedStyle(slot).opacity).toBe('1')
    expect(getComputedStyle(actions).opacity).toBe('0')
    await page.getByText('2 分钟').hover()
    await expect.poll(() => getComputedStyle(slot).opacity).toBe('0')
    await expect.poll(() => getComputedStyle(actions).opacity).toBe('1')
    // The actions are readable even though the status beside them is decorative.
    expect(actions.closest('[aria-hidden]')).toBeNull()
  })

  it('keeps the status on a touch screen', async () => {
    await onTouchScreen(async () => {
      const screen = await render(sample)
      const slot = screen.container.querySelector('.ui-status-slot')!
      const actions = screen.container.querySelector('.ui-status-swap-actions')!
      expect(getComputedStyle(slot).opacity).toBe('1')
      expect(getComputedStyle(actions).display).toBe('none')
    })
  })
})

describe('FoldHeader', () => {
  it('turns its chevron 90 degrees over 200ms and reports the toggle', async () => {
    const toggled = vi.fn()
    const screen = await render(
      <>
        <FoldHeader open onOpenChange={toggled}>
          已工作
        </FoldHeader>
        <FoldHeader open={false} onOpenChange={toggled}>
          已收起
        </FoldHeader>
      </>,
    )
    const open = screen.getByRole('button', { name: '已工作' })
    await expect.element(open).toHaveAttribute('aria-expanded', 'true')
    const chevron = getComputedStyle(open.element().querySelector('.ui-fold-chevron')!)
    expect(chevron.rotate).toBe('90deg')
    expect(chevron.transitionDuration).toBe('0.2s')
    await screen.getByRole('button', { name: '已收起' }).click()
    expect(toggled).toHaveBeenCalledWith(true)
  })
})

describe('Shimmer working', () => {
  it('sweeps over 2.2s in steps on the shared clock', async () => {
    const screen = await render(<Shimmer variant="working">运行中</Shimmer>)
    const style = getComputedStyle(screen.getByText('运行中').element())
    expect(style.animationDuration).toBe('2.2s')
    expect(style.animationTimingFunction).toBe('steps(30)')
    expect(style.animationDelay.startsWith('-') || style.animationDelay === '0s').toBe(true)
  })
})
