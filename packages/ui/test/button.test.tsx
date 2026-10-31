import { describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { Plus, Settings } from 'lucide-react'
import { Button, Count, IconButton, InlineNotice } from '../src/index.ts'
import { onTouchScreen, press } from './helpers.ts'

const style = (element: Element, pseudo?: string) => getComputedStyle(element, pseudo)
/** The open tooltips' text; a closed one is hidden, so role queries no longer find it. */
const openTooltips = () => Array.from(document.querySelectorAll('.ui-tooltip:popover-open'), element => element.textContent)
const wait = (ms: number) => new Promise(done => setTimeout(done, ms))

describe('buttons', () => {
  it('keeps a disabled button focusable with its reason, and ignores its clicks, even as a form submit', async () => {
    const submitted = vi.fn()
    const clicked = vi.fn()
    const screen = await render(
      <form
        onSubmit={event => {
          event.preventDefault()
          submitted()
        }}>
        <input aria-label="名称" />
        <Button type="submit" variant="primary" disabled tooltip="填写名称后可以创建" onClick={clicked}>
          创建
        </Button>
      </form>,
    )
    const button = screen.getByRole('button', { name: '创建' })
    await expect.element(button).toHaveAttribute('aria-disabled', 'true')
    await expect.element(button).not.toHaveAttribute('disabled')
    press(button)
    await userEvent.click(screen.getByRole('textbox', { name: '名称' }))
    await userEvent.keyboard('{Enter}')
    expect(clicked).not.toHaveBeenCalled()
    expect(submitted).not.toHaveBeenCalled()
    expect(style(button.element()).opacity).toBe('0.45')

    await userEvent.tab()
    await expect.element(button).toHaveFocus()
    await expect.element(screen.getByRole('tooltip')).toHaveTextContent('填写名称后可以创建')
    await expect.element(button).toHaveAccessibleDescription('填写名称后可以创建')
  })

  it('keeps its width, swaps the label and the leading glyph, and takes no clicks while it runs', async () => {
    const clicked = vi.fn()
    const screen = await render(
      <Button variant="primary" icon={Plus} onClick={clicked}>
        添加服务
      </Button>,
    )
    const button = screen.getByRole('button')
    const before = button.element().getBoundingClientRect().width
    expect(button.element().querySelector('.lucide-plus')).not.toBeNull()
    await screen.rerender(
      <Button variant="primary" icon={Plus} loading loadingLabel="中" onClick={clicked}>
        添加服务
      </Button>,
    )
    await expect.element(button).toHaveAttribute('aria-busy', 'true')
    await expect.element(button).toHaveTextContent('中')
    expect(button.element().querySelector('.lucide-plus')).toBeNull()
    expect(button.element().querySelector('.ui-spinner')).not.toBeNull()
    expect(Math.abs(button.element().getBoundingClientRect().width - before)).toBeLessThan(1)
    press(button)
    expect(clicked).not.toHaveBeenCalled()
    // The primary keeps the accent while it runs.
    expect(style(button.element()).backgroundColor).toBe('rgb(36, 97, 224)')
  })

  it('stays busy, not disabled, at full strength while it runs, even when the caller also disables it', async () => {
    const clicked = vi.fn()
    const screen = await render(
      <Button variant="primary" disabled loading onClick={clicked}>
        保存
      </Button>,
    )
    const button = screen.getByRole('button', { name: '保存' })
    await expect.element(button).toHaveAttribute('aria-busy', 'true')
    await expect.element(button).not.toHaveAttribute('aria-disabled')
    expect(style(button.element()).opacity).toBe('1')
    expect(style(button.element()).backgroundColor).toBe('rgb(36, 97, 224)')
    press(button)
    expect(clicked).not.toHaveBeenCalled()
  })

  it('puts a shortcut in the tooltip and never inside the button', async () => {
    const screen = await render(
      <Button variant="primary" shortcut="⌘⏎">
        允许一次
      </Button>,
    )
    const button = screen.getByRole('button', { name: '允许一次' })
    expect(button.element().querySelector('kbd')).toBeNull()
    await userEvent.tab()
    const tooltip = screen.getByRole('tooltip')
    await expect.element(tooltip).toBeVisible()
    expect(tooltip.element().querySelector('kbd')?.textContent).toBe('⌘⏎')
    await userEvent.keyboard('{Escape}')
    await expect.poll(openTooltips).toEqual([])
  })

  it('shows a tooltip after 400ms of hover, glides it to a neighbour at once, and hides it on leaving', async () => {
    const screen = await render(
      <div>
        <IconButton label="设置" icon={Settings} />
        <IconButton label="添加" icon={Plus} />
        <span>别处</span>
      </div>,
    )
    // A tooltip hidden by an earlier test would make the next one appear at once.
    await wait(350)
    const settings = screen.getByRole('button', { name: '设置' })
    await userEvent.hover(settings)
    await wait(250)
    expect(openTooltips()).toEqual([])
    await expect.poll(openTooltips, { timeout: 2000 }).toEqual(['设置'])
    // It fades in from a scale of .98 over --m-enter, inverted.
    const first = document.querySelector<HTMLElement>('.ui-tooltip:popover-open')!
    expect(first.getAnimations().map(item => (item as CSSAnimation).animationName)).toEqual(['ui-pop'])
    expect([style(first).backgroundColor, style(first).color]).toEqual(['rgb(24, 24, 27)', 'rgb(250, 250, 250)'])
    // The label already names the button, so the tooltip does not describe it a second time.
    expect(settings.element().hasAttribute('aria-describedby')).toBe(false)
    await userEvent.hover(screen.getByRole('button', { name: '添加' }))
    await wait(100)
    expect(openTooltips()).toEqual(['添加'])
    // The neighbour's tooltip glides from where the last one stood instead of popping in again.
    const next = document.querySelector<HTMLElement>('.ui-tooltip:popover-open')!
    expect([next.hasAttribute('data-glide'), style(next).transitionProperty]).toEqual([true, 'left, top'])
    await userEvent.hover(screen.getByText('别处'))
    expect(openTooltips()).toEqual([])
  })

  it('names icon buttons by their label, shows a toggle as a neutral press and makes them 44px targets on touch', async () => {
    const screen = await render(<IconButton label="会话信息" icon={Settings} pressed />)
    const button = screen.getByRole('button', { name: '会话信息' })
    await expect.element(button).toHaveAttribute('aria-pressed', 'true')
    // On: the hover fill and ink, never the accent.
    expect(style(button.element(), '::before').backgroundColor).toBe('rgba(0, 0, 0, 0.04)')
    expect(style(button.element()).color).toBe('rgb(24, 24, 27)')
    expect(button.element().getBoundingClientRect().width).toBe(28)
    await onTouchScreen(async () => {
      const box = button.element().getBoundingClientRect()
      expect([box.width, box.height]).toEqual([44, 44])
      // Only the box grows: the face keeps its size, centred.
      expect([style(button.element(), '::before').width, style(button.element(), '::before').top]).toEqual(['28px', '8px'])
    })
  })

  it('shows the trigger of an open menu as a neutral press, like a toggle that is on', async () => {
    const screen = await render(
      <>
        <IconButton label="更多" icon={Settings} aria-haspopup="menu" aria-expanded />
        <IconButton label="收起" icon={Settings} aria-haspopup="menu" aria-expanded={false} />
      </>,
    )
    const open = screen.getByRole('button', { name: '更多' }).element()
    const closed = screen.getByRole('button', { name: '收起' }).element()
    expect(style(open, '::before').backgroundColor).toBe('rgba(0, 0, 0, 0.04)')
    expect(getComputedStyle(open).color).toBe(getComputedStyle(document.documentElement).color)
    expect(style(closed, '::before').backgroundColor).toBe('rgba(0, 0, 0, 0)')
  })

  it('keeps a 44px target around a box a dense row keeps small, and sets a count past the corner on the surface', async () => {
    const screen = await render(
      <IconButton label="2 项待批准" icon={Settings} style={{ minWidth: 0, minHeight: 0 }} badge={<Count value={2} tone="warn" />} />,
    )
    const button = screen.getByRole('button', { name: '2 项待批准' }).element()
    const face = button.getBoundingClientRect()
    const badge = button.querySelector('.ui-icon-button-badge')!
    // The count's corner sits 4px past the face's, on an opaque pill of the surface with a 2px cut-out ring.
    expect([badge.getBoundingClientRect().right - face.right, face.top - badge.getBoundingClientRect().top]).toEqual([4, 4])
    expect(style(badge).backgroundColor).toBe('rgb(255, 255, 255)')
    expect(style(badge).boxShadow).toBe('rgb(255, 255, 255) 0px 0px 0px 2px')
    await onTouchScreen(async () => {
      expect([button.getBoundingClientRect().width, style(button, '::after').width, style(button, '::after').height]).toEqual([
        28,
        '44px',
        '44px',
      ])
    })
  })

  it('draws a secondary button as a soft fill, and outlined (raised inside a line-strong ring) as outline or inside a tint', async () => {
    const screen = await render(
      <div>
        <Button>稍后</Button>
        <Button variant="outline">拒绝</Button>
        <Button variant="danger">撤销此设备</Button>
        <InlineNotice tone="warn" title="连接已中断" action={<Button size="xs">重试</Button>} />
      </div>,
    )
    const plain = style(screen.getByRole('button', { name: '稍后' }).element())
    expect([plain.backgroundColor, plain.boxShadow]).toEqual(['rgba(0, 0, 0, 0.04)', 'none'])
    for (const name of ['拒绝', '撤销此设备', '重试']) {
      const outlined = style(screen.getByRole('button', { name }).element())
      expect([outlined.backgroundColor, outlined.boxShadow.startsWith('rgb(220, 220, 224) 0px 0px 0px 1px inset')], name).toEqual([
        'rgb(255, 255, 255)',
        true,
      ])
    }
    expect(style(screen.getByRole('button', { name: '撤销此设备' }).element()).color).toBe('rgb(185, 28, 28)')
  })

  it('presses a button to .97 over --m-micro, but not one that opens a menu, and rings the keyboard focus in the accent', async () => {
    const screen = await render(
      <div>
        <Button variant="primary">允许</Button>
        <Button menu>计划</Button>
      </div>,
    )
    const button = screen.getByRole('button', { name: '允许' }).element()
    expect(style(button).transitionProperty).toContain('transform')
    // The press, as the stylesheet declares it: every button but a disabled, busy or menu-opening one.
    const presses: CSSStyleRule[] = []
    const walk = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule && /^\.ui-button:active/u.test(rule.selectorText)) presses.push(rule)
        else if (rule instanceof CSSGroupingRule) walk(rule.cssRules)
      }
    }
    for (const sheet of Array.from(document.styleSheets)) walk(sheet.cssRules)
    expect(presses.map(rule => [rule.style.transform, /\[data-menu\]/u.test(rule.selectorText)])).toContainEqual(['scale(0.97)', true])
    // A filled button draws the keyboard ring outside it; a quiet one inside its own edge.
    await userEvent.tab()
    expect(document.activeElement).toBe(button)
    expect([style(button).outlineColor, style(button).outlineWidth, style(button).outlineOffset]).toEqual([
      'rgb(36, 97, 224)',
      '2px',
      '2px',
    ])
    await userEvent.tab()
    expect(style(screen.getByRole('button', { name: '计划' }).element()).outlineOffset).toBe('-2px')
  })

  it('sizes buttons on the scale of 24, 28, 32 and 44', async () => {
    const screen = await render(
      <div>
        {(['xs', 'sm', 'md', 'lg'] as const).map(size => (
          <Button key={size} size={size}>
            {size}
          </Button>
        ))}
      </div>,
    )
    const heights = ['xs', 'sm', 'md', 'lg'].map(
      size => screen.getByRole('button', { name: size }).element().getBoundingClientRect().height,
    )
    expect(heights).toEqual([24, 28, 32, 44])
  })
})
