import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'

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
  CheckGlyph,
  FileGlyph,
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
      <Button icon={CheckGlyph} done doneLabel="已允许" onClick={clicked}>
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
      <SelectButton leading={<Tile size={16} icon={FileGlyph} />} disabled onClick={clicked}>
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
          { value: 'a', label: '改动', icon: FileGlyph, stat: { added: 60, removed: 6 } },
          { value: 'b', label: 'notes.md', icon: FileGlyph, closeLabel: '关闭 notes.md', fresh: true },
        ]}
      />
    )
  }

  it('puts the × after the label, clear of it, in a closable tab without a glyph', async () => {
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
    expect(close.left).toBeGreaterThanOrEqual(label.right)
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

  it('keeps the glyph and shows × in its own slot at the end on hover, and closes with it, Delete or a middle click', async () => {
    const closed = vi.fn()
    const screen = await render(<Sample onClose={closed} />)
    const tab = screen.getByRole('tab', { name: /notes/u })
    const close = screen.getByRole('button', { name: '关闭 notes.md' })
    const glyph = tab.element().querySelector('.ui-panel-tab-glyph')!
    expect(getComputedStyle(close.element()).opacity).toBe('0')
    const before = tab.element().getBoundingClientRect()
    await tab.hover()
    await expect.poll(() => getComputedStyle(close.element()).opacity).toBe('1')
    expect(getComputedStyle(glyph).opacity).toBe('1')
    expect(tab.element().getBoundingClientRect().width).toBe(before.width)
    expect(close.element().getBoundingClientRect().left).toBeGreaterThanOrEqual(
      tab.element().querySelector('.ui-panel-tab-label')!.getBoundingClientRect().right,
    )
    tab.element().dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }))
    expect(closed).toHaveBeenCalledWith('b')
    closed.mockClear()
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
  const stack = (keys: string[], secure: string[] = []) => (
    <LiveChanges.Provider value="live">
      <DrawerStack>
        {keys.map(key => (
          <Drawer key={key} label={key} secure={secure.includes(key)}>
            <button type="button">{`答 ${key}`}</button>
          </Drawer>
        ))}
      </DrawerStack>
    </LiveChanges.Provider>
  )

  it('shows every drawer whole as a card with the modal radius, 8px apart, and opens nothing on hover', async () => {
    const screen = await render(<div style={{ width: 500 }}>{stack(['a', 'b'])}</div>)
    const [back, front] = Array.from(screen.container.querySelectorAll<HTMLElement>('.ui-drawer'))
    const style = getComputedStyle(front!)
    expect([style.borderTopLeftRadius, style.borderBottomRightRadius]).toEqual(['16px', '16px'])
    expect(front!.getBoundingClientRect().top - back!.getBoundingClientRect().bottom).toBe(8)
    expect(back!.getBoundingClientRect().width).toBe(front!.getBoundingClientRect().width)
    const before = back!.getBoundingClientRect().height
    await page.getByRole('region', { name: 'b' }).hover()
    expect(back!.getBoundingClientRect().height).toBe(before)
    expect(back!.hasAttribute('inert')).toBe(false)
  })

  it('slides what appears and keeps what goes until it has left, when the page saw it', async () => {
    const screen = await render(stack(['a']))
    const only = screen.container.querySelector<HTMLElement>('.ui-drawer')!
    expect(only.dataset.entering).toBeUndefined()
    await screen.rerender(stack(['a', 'b']))
    await expect.poll(() => screen.container.querySelectorAll('.ui-drawer[data-entering]').length).toBe(1)
    await screen.rerender(stack(['a']))
    expect(screen.container.querySelectorAll('.ui-drawer[data-leaving]').length).toBe(1)
    expect(screen.container.querySelector('.ui-drawer[data-leaving]')!.hasAttribute('inert')).toBe(true)
    await expect.poll(() => screen.container.querySelectorAll('.ui-drawer').length).toBe(1)
  })

  it('never moves a security surface: it appears and is taken away at once', async () => {
    const screen = await render(stack(['a'], ['b']))
    await screen.rerender(stack(['a', 'b'], ['b']))
    const secure = screen.container.querySelector<HTMLElement>('.ui-drawer[data-secure]')!
    expect(secure.dataset.entering).toBeUndefined()
    await screen.rerender(stack(['a'], ['b']))
    expect(screen.container.querySelectorAll('.ui-drawer')).toHaveLength(1)
    expect(screen.container.querySelector('.ui-drawer[data-secure]')).toBeNull()
  })

  it('shows and removes at once when the state was established again', async () => {
    const swap = (epoch: string, keys: string[]) => (
      <LiveChanges.Provider value={epoch}>
        <DrawerStack>
          {keys.map(key => (
            <Drawer key={key} label={key}>
              {key}
            </Drawer>
          ))}
        </DrawerStack>
      </LiveChanges.Provider>
    )
    const screen = await render(swap('one', ['a']))
    await screen.rerender(swap('two', ['b']))
    expect(Array.from(screen.container.querySelectorAll('.ui-drawer'), item => item.textContent)).toEqual(['b'])
    expect(screen.container.querySelector('.ui-drawer[data-entering]')).toBeNull()
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
