import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { press } from './helpers.ts'
import { Ellipsis, Pencil, Shield, Trash2 } from 'lucide-react'
import {
  IconButton,
  Menu,
  MenuFooterLink,
  MenuFooterNote,
  MenuPanel,
  PermissionMenu,
  ValuePicker,
  type PermissionLevel,
} from '../src/index.ts'

const MODELS = [
  { value: 'alpha', label: 'alpha-large' },
  { value: 'beta', label: 'beta-mini' },
  { value: 'gamma', label: 'gamma-vision', disabledReason: '此模型服务不可用' },
  { value: 'delta', label: 'delta-code' },
]

function Model({ onChange }: { onChange?: (value: string) => void }) {
  const [model, setModel] = useState('alpha')
  return (
    <>
      <ValuePicker
        label="模型"
        value={model}
        options={MODELS}
        onValueChange={value => {
          setModel(value)
          onChange?.(value)
        }}
      />
      <button type="button">之后</button>
    </>
  )
}

const focused = () => document.activeElement
/** The box of the text a picker shows (the ink, not the room its element may keep). */
const valueBox = (picker: Element | undefined) => {
  const range = document.createRange()
  const text = picker?.querySelector('.ui-value-picker-text[data-shown]')
  if (text) range.selectNodeContents(text)
  return range.getBoundingClientRect()
}
const rect = (element: Element | null | undefined) => element?.getBoundingClientRect() ?? new DOMRect()
const left = (element: Element | null) => element?.getBoundingClientRect().left
const centre = (element: Element | null) => {
  const box = element?.getBoundingClientRect()
  return box ? box.left + box.width / 2 : undefined
}
const frames = (count: number) =>
  new Promise<void>(done => {
    const step = (remaining: number) => {
      if (remaining === 0) done()
      else requestAnimationFrame(() => step(remaining - 1))
    }
    step(count)
  })

describe('value picker', () => {
  it('opens on Enter, Space or ↓ with focus on the current value, and Escape closes it back onto the trigger', async () => {
    const screen = await render(<Model />)
    const trigger = screen.getByRole('button', { name: '模型：alpha-large' })
    await expect.element(trigger).toHaveAttribute('aria-haspopup', 'menu')
    for (const key of ['{Enter}', ' ', '{ArrowDown}']) {
      trigger.element().focus()
      await userEvent.keyboard(key)
      await expect.element(trigger).toHaveAttribute('aria-expanded', 'true')
      await expect.element(screen.getByRole('menuitemradio', { name: 'alpha-large' })).toHaveFocus()
      await expect.element(screen.getByRole('menuitemradio', { name: 'alpha-large' })).toHaveAttribute('aria-checked', 'true')
      await userEvent.keyboard('{Escape}')
      await expect.element(trigger).toHaveAttribute('aria-expanded', 'false')
      expect(focused()).toBe(trigger.element())
    }
  })

  it('moves with ↑/↓ through every value, stops on one that cannot be chosen to read its reason, and chooses with Enter', async () => {
    const changed = vi.fn()
    const screen = await render(<Model onChange={changed} />)
    await userEvent.click(screen.getByRole('button', { name: '模型：alpha-large' }))
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    const unavailable = screen.getByRole('menuitemradio', { name: 'gamma-vision' })
    await expect.element(unavailable).toHaveFocus()
    await expect.element(unavailable).toHaveAttribute('aria-disabled', 'true')
    await expect.element(unavailable).toHaveAccessibleDescription('此模型服务不可用')
    await userEvent.keyboard('{Enter}')
    expect(changed).not.toHaveBeenCalled()
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(changed).toHaveBeenCalledWith('delta')
    const trigger = screen.getByRole('button', { name: '模型：delta-code' })
    await expect.element(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(focused()).toBe(trigger.element())
  })

  it('jumps to a value by its first letters', async () => {
    const screen = await render(<Model />)
    await userEvent.click(screen.getByRole('button', { name: '模型：alpha-large' }))
    await userEvent.keyboard('de')
    await expect.element(screen.getByRole('menuitemradio', { name: 'delta-code' })).toHaveFocus()
    // A pause ends the typed prefix.
    await new Promise(done => setTimeout(done, 600))
    await userEvent.keyboard('b')
    await expect.element(screen.getByRole('menuitemradio', { name: 'beta-mini' })).toHaveFocus()
  })

  it('closes on Tab or a press outside without taking focus back', async () => {
    const screen = await render(<Model />)
    const trigger = screen.getByRole('button', { name: '模型：alpha-large' })
    await userEvent.click(trigger)
    await userEvent.keyboard('{Tab}')
    await expect.element(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(focused()).not.toBe(trigger.element())
    await userEvent.click(trigger)
    await expect.element(trigger).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(screen.getByRole('button', { name: '之后' }))
    await expect.element(trigger).toHaveAttribute('aria-expanded', 'false')
    await expect.element(screen.getByRole('button', { name: '之后' })).toHaveFocus()
  })

  it('stays open when opening scrolled its trigger into view, and closes once a scroll moves the trigger', async () => {
    const screen = await render(
      <div data-testid="scroller" style={{ height: 300, overflow: 'auto' }}>
        <div style={{ height: 600 }} />
        <Model />
        <div style={{ height: 600 }} />
      </div>,
    )
    const scroller = screen.getByTestId('scroller').element()
    let scrolls = 0
    scroller.addEventListener('scroll', () => {
      scrolls += 1
    })
    const button = screen.getByRole('button', { name: '模型：alpha-large' })
    const trigger = button.element()
    // Focus scrolls the trigger into view at once, and the browser reports that scroll a frame after the layer opens
    // (React renders the click's update and runs its effects in microtasks, before the next frame).
    trigger.focus()
    press(button)
    for (let task = 0; task < 5; task++) await Promise.resolve()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(scrolls).toBe(0)
    await frames(3)
    expect(scrolls).toBeGreaterThan(0)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    scroller.scrollTop += 40
    await expect.poll(() => trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows a single possible value as plain text without an arrow', async () => {
    const screen = await render(
      <ValuePicker label="项目" value="latch-app" options={[{ value: 'latch-app', label: 'latch-app' }]} onValueChange={() => {}} />,
    )
    await expect.element(screen.getByText('latch-app')).toBeVisible()
    expect(screen.container.querySelector('button')).toBeNull()
    expect(screen.container.querySelector('.lucide-chevrons-up-down')).toBeNull()
  })

  it('ends in chevrons-up-down and writes an unchosen value in text-3, never in a warning colour', async () => {
    const screen = await render(
      <ValuePicker label="模型" value={undefined} placeholder="选择模型" options={MODELS} onValueChange={() => {}} />,
    )
    const trigger = screen.getByRole('button', { name: '模型：选择模型' })
    expect(trigger.element().querySelector('.lucide-chevrons-up-down')).not.toBeNull()
    expect(trigger.element().querySelector('.lucide-chevron-down')).toBeNull()
    const text = trigger.element().querySelector('.ui-value-picker-text[data-shown]')
    expect(text && getComputedStyle(text).color).toBe('rgb(96, 95, 93)')
  })
})

type Level = 'L0' | 'L1' | 'L2' | 'L3'
const LEVELS: Array<PermissionLevel<Level>> = [
  { value: 'L0', title: '只读', description: '不改文件，不运行命令' },
  { value: 'L1', title: '逐项询问', description: '改文件、运行命令前先问你' },
  { value: 'L2', title: '自动编辑', description: '项目内直接编辑，命令仍会询问' },
  { value: 'L3', title: '完全访问', description: '不再询问，可以改动整台电脑 · 需本机确认', risk: true, disabledReason: undefined },
]

function Ceiling({ verify }: { verify: (level: Level) => Promise<void> }) {
  const [level, setLevel] = useState<Level>('L1')
  return (
    <PermissionMenu
      label="权限"
      leading={Shield}
      header={{ title: '在这台电脑上发起的会话' }}
      levels={LEVELS}
      defaultValue="L1"
      value={level}
      footer={<MenuFooterNote>调高要在这台电脑上验证身份</MenuFooterNote>}
      onValueChange={async next => {
        if (LEVELS.findIndex(item => item.value === next) > LEVELS.findIndex(item => item.value === level)) await verify(next)
        setLevel(next)
      }}
    />
  )
}

/** A promise the test settles. */
function deferred() {
  const settle: { resolve: () => void } = { resolve: () => {} }
  const promise = new Promise<void>(done => {
    settle.resolve = done
  })
  return { promise, resolve: () => settle.resolve() }
}

const SHORT_LEVELS: Array<{ value: Level; label: string }> = [
  { value: 'L0', label: '只读' },
  { value: 'L1', label: '逐项询问' },
]

describe('value picker spacing', () => {
  it('spaces its glyph, value and arrow 6 apart, and keeps room for 「等待验证…」 only in a toolbar permission menu', async () => {
    const screen = await render(
      <div>
        <PermissionMenu label="工具栏权限" leading={Shield} levels={LEVELS} value="L0" onValueChange={() => {}} />
        <PermissionMenu label="设置行权限" align="end" levels={LEVELS} value="L3" onValueChange={() => {}} />
        <ValuePicker label="模型" value="alpha" options={MODELS} onValueChange={() => {}} />
        <ValuePicker label="项目" leading={Shield} value="L0" options={SHORT_LEVELS} onValueChange={() => {}} />
      </div>,
    )
    const [toolbar, setting, model, project] = Array.from(screen.container.querySelectorAll('.ui-value-picker'))
    const gaps = (picker: Element | undefined) => {
      const lead = picker?.querySelector('.ui-value-picker-lead')
      const value = valueBox(picker)
      const arrow = rect(picker?.querySelector('.ui-value-picker-chevron'))
      return { lead: lead ? Math.round(value.left - rect(lead).right) : undefined, arrow: Math.round(arrow.left - value.right) }
    }
    // The glyph (the amber shield of full access too) is always 6 from the value.
    expect(gaps(toolbar).lead).toBe(6)
    expect(gaps(setting)).toEqual({ lead: 6, arrow: 6 })
    expect(gaps(project)).toEqual({ lead: 6, arrow: 6 })
    expect(gaps(model)).toEqual({ lead: undefined, arrow: 6 })
    // In a toolbar the permission menu keeps 「等待验证…」's width after its short value, so the arrow will not move.
    const pending = toolbar?.querySelector('.ui-value-picker-text[data-pending]')
    expect(gaps(toolbar).arrow).toBe(Math.round(rect(pending).width - valueBox(toolbar).width) + 6)
    expect(gaps(toolbar).arrow).toBeGreaterThan(6)
  })

  it('lines the inspector values up with their column, and the phone rows of a card up with their arrows', async () => {
    const screen = await render(
      <div>
        <div style={{ display: 'grid', justifyItems: 'start', width: 160, marginLeft: 40 }}>
          <PermissionMenu label="权限" size="xs" chevron="hover" bleed="both" levels={LEVELS} value="L1" onValueChange={() => {}} />
        </div>
        <div style={{ width: 358 }}>
          <ValuePicker variant="row" label="模型" value="alpha" options={MODELS} onValueChange={() => {}} />
          <PermissionMenu variant="row" label="权限" levels={LEVELS} value="L1" onValueChange={() => {}} />
          <ValuePicker variant="row" label="项目" value="L0" options={SHORT_LEVELS} onValueChange={() => {}} />
        </div>
      </div>,
    )
    const [inspector, ...rows] = Array.from(screen.container.querySelectorAll('.ui-value-picker'))
    // The xs value bleeds 6 past the column on both sides, so its text starts exactly on the column's edge.
    expect(Math.round(valueBox(inspector).left)).toBe(Math.round(rect(inspector?.parentElement).left))
    const ends = rows.map(row => Math.round(rect(row.querySelector('.ui-value-picker-chevron')).left - valueBox(row).right))
    expect(ends).toEqual([6, 6, 6])
  })
})

describe('permission menu', () => {
  it('lists the levels lowest first with their consequences, marks the default, and keeps amber off the menu', async () => {
    const screen = await render(<Ceiling verify={async () => {}} />)
    await userEvent.click(screen.getByRole('button', { name: '权限：逐项询问' }))
    const menu = screen.getByRole('menu', { name: '权限：在这台电脑上发起的会话' })
    const items = menu.element().querySelectorAll('[role="menuitemradio"]')
    expect(Array.from(items, item => item.querySelector('.ui-menu-item-title')?.textContent)).toEqual([
      '只读',
      '逐项询问',
      '自动编辑',
      '完全访问',
    ])
    await expect
      .element(screen.getByRole('menuitemradio', { name: '逐项询问 默认' }))
      .toHaveAccessibleDescription('改文件、运行命令前先问你')
    expect(menu.element().querySelector('.lucide-shield-alert')).toBeNull()
    // The layer itself is 320 wide, its 4px inside included.
    expect(getComputedStyle(menu.element().closest('.ui-popover')!).width).toBe('320px')
  })

  it('shows 「等待验证…」 in place while a raise is verified and the amber shield once full access is chosen', async () => {
    const verification = deferred()
    const verify = vi.fn(() => verification.promise)
    const screen = await render(<Ceiling verify={verify} />)
    await userEvent.click(screen.getByRole('button', { name: '权限：逐项询问' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: '完全访问' }))
    expect(verify).toHaveBeenCalledWith('L3')
    const trigger = screen.getByRole('button', { name: '权限：等待验证…' })
    await expect.element(trigger).toHaveAttribute('aria-busy', 'true')
    expect(trigger.element().querySelector('.ui-spinner')).not.toBeNull()
    // The arrow stays where it was: the trigger keeps room for the wider of the value and the pending text.
    const width = trigger.element().getBoundingClientRect().width
    verification.resolve()
    await expect.element(screen.getByRole('button', { name: '权限：完全访问' })).not.toHaveAttribute('aria-busy')
    expect(screen.getByRole('button', { name: '权限：完全访问' }).element().getBoundingClientRect().width).toBe(width)
    const shield = screen.getByRole('button', { name: '权限：完全访问' }).element().querySelector('.lucide-shield-alert')
    expect(shield && getComputedStyle(shield).color).toBe('rgb(154, 83, 0)')
  })

  it('keeps the value when a verification is cancelled', async () => {
    const screen = await render(<Ceiling verify={() => Promise.reject(new Error('cancelled'))} />)
    await userEvent.click(screen.getByRole('button', { name: '权限：逐项询问' }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: '完全访问' }))
    await expect.element(screen.getByRole('button', { name: '权限：逐项询问' })).not.toHaveAttribute('aria-busy')
  })
})

describe('menu rows', () => {
  it("puts the check of a two-line item on its title's line, and spaces a reason 4 under it and 6 from its glyph", async () => {
    const screen = await render(
      <div className="ui-popover">
        <MenuPanel
          label="权限"
          selection
          sections={[
            {
              id: 'levels',
              items: LEVELS.map(level => ({
                id: level.value,
                label: level.title,
                description: level.description,
                checked: level.value === 'L3',
                disabledReason: level.value === 'L2' ? 'goose 无法保证此级别' : undefined,
                onSelect: () => {},
              })),
            },
          ]}
        />
      </div>,
    )
    const middle = (element: Element | null | undefined) => {
      const box = rect(element)
      return box.top + box.height / 2
    }
    const chosen = screen.getByRole('menuitemradio', { name: '完全访问' }).element()
    expect(Math.abs(middle(chosen.querySelector('.lucide-check')) - middle(chosen.querySelector('.ui-menu-item-title')))).toBeLessThan(1)
    const blocked = screen.getByRole('menuitemradio', { name: '自动编辑' }).element()
    const reason = blocked.querySelector('.ui-menu-item-reason')
    expect(Math.round(rect(reason).top - rect(blocked.querySelector('.ui-menu-item-description')).bottom)).toBe(4)
    expect(getComputedStyle(reason!).columnGap).toBe('6px')
  })

  it("opens the menus of inspector values and settings rows on the trigger's end, and the composer's on its start", async () => {
    const screen = await render(
      <div style={{ display: 'grid', justifyItems: 'center', paddingTop: 40 }}>
        <PermissionMenu label="检查器权限" size="xs" chevron="hover" bleed="both" levels={LEVELS} value="L1" onValueChange={() => {}} />
        <PermissionMenu label="设置行权限" bleed="end" levels={LEVELS} value="L1" onValueChange={() => {}} />
        <PermissionMenu label="工具栏权限" levels={LEVELS} value="L1" onValueChange={() => {}} />
      </div>,
    )
    const edges = async (name: string) => {
      const trigger = screen.getByRole('button', { name: `${name}：逐项询问` })
      await userEvent.click(trigger)
      const layer = screen.getByRole('menu', { name }).element().closest('.ui-popover')
      const result = {
        start: Math.round(rect(layer).left - rect(trigger.element()).left),
        end: Math.round(rect(layer).right - rect(trigger.element()).right),
      }
      await userEvent.keyboard('{Escape}')
      return result
    }
    expect((await edges('检查器权限')).end).toBe(0)
    expect((await edges('设置行权限')).end).toBe(0)
    expect((await edges('工具栏权限')).start).toBe(0)
  })

  it("starts its footer rows on the titles' column, and draws a destructive item and its glyph in one red", async () => {
    const screen = await render(
      <div>
        <div className="ui-popover">
          <MenuPanel
            label="权限"
            selection
            sections={[
              {
                id: 'levels',
                items: LEVELS.slice(0, 2).map(level => ({
                  id: level.value,
                  label: level.title,
                  checked: level.value === 'L1',
                  onSelect: () => {},
                })),
              },
            ]}
            footer={<MenuFooterLink onClick={() => {}}>电脑与权限上限…</MenuFooterLink>}
          />
        </div>
        <div className="ui-popover">
          <MenuPanel
            label="会话"
            sections={[
              {
                id: 'actions',
                items: [
                  { id: 'rename', label: '重命名', icon: Pencil, onSelect: () => {} },
                  { id: 'delete', label: '删除…', icon: Trash2, danger: true, onSelect: () => {} },
                ],
              },
            ]}
            footer={<MenuFooterNote>调高要在这台电脑上验证身份</MenuFooterNote>}
          />
        </div>
      </div>,
    )
    const [levels, actions] = Array.from(screen.container.querySelectorAll('.ui-menu'))
    const link = levels?.querySelector('.ui-menu-footer-link')
    expect(left(link?.querySelector('.ui-menu-footer-text') ?? null)).toBe(left(levels?.querySelector('.ui-menu-item-title') ?? null))
    expect(getComputedStyle(link!).color).toBe(getComputedStyle(document.documentElement).color)
    const note = actions?.querySelector('.ui-menu-footer-note')
    expect(left(note?.querySelector('.ui-menu-footer-text') ?? null)).toBe(left(actions?.querySelector('.ui-menu-item-title') ?? null))
    expect(centre(note?.querySelector('.lucide-lock') ?? null)).toBe(centre(actions?.querySelector('.ui-menu-item-lead') ?? null))
    const danger = screen.getByRole('menuitem', { name: '删除…' }).element()
    expect(getComputedStyle(danger.querySelector('.lucide-trash-2')!).color).toBe(getComputedStyle(danger).color)
    expect(getComputedStyle(danger).color).toBe('rgb(180, 35, 24)')
  })

  it('turns an action glyph from the icon colour to text-1 while its item is hovered, and keeps a destructive glyph red', async () => {
    const screen = await render(
      <div className="ui-popover">
        <MenuPanel
          label="会话"
          sections={[
            {
              id: 'actions',
              items: [
                { id: 'rename', label: '重命名', icon: Pencil, onSelect: () => {} },
                { id: 'delete', label: '删除…', icon: Trash2, danger: true, onSelect: () => {} },
              ],
            },
          ]}
        />
      </div>,
    )
    const rename = screen.getByRole('menuitem', { name: '重命名' })
    const glyph = () => getComputedStyle(rename.element().querySelector('.lucide-pencil')!).color
    expect(glyph()).toBe('rgb(124, 124, 122)')
    await userEvent.hover(rename)
    await expect.poll(glyph).toBe(getComputedStyle(document.documentElement).color)
    const danger = screen.getByRole('menuitem', { name: '删除…' })
    await userEvent.hover(danger)
    expect(getComputedStyle(danger.element().querySelector('.lucide-trash-2')!).color).toBe('rgb(180, 35, 24)')
  })

  it('names a menu by its label and whom it acts on, and describes it with the header meta', async () => {
    const screen = await render(
      <div>
        <MenuPanel
          label="权限"
          selection
          header={{ title: '在这台电脑上发起的会话' }}
          sections={[{ id: 'levels', items: [{ id: 'L1', label: '逐项询问', checked: true, onSelect: () => {} }] }]}
        />
        <MenuPanel
          label="模型"
          selection
          header={{ title: '模型', meta: '执行端' }}
          sections={[{ id: 'models', items: [{ id: 'alpha', label: 'alpha-large', checked: true, onSelect: () => {} }] }]}
        />
      </div>,
    )
    await expect.element(screen.getByRole('menu', { name: '权限：在这台电脑上发起的会话', exact: true })).toBeInTheDocument()
    // A header that only repeats the label adds nothing to the name; its meta is the description.
    await expect.element(screen.getByRole('menu', { name: '模型', exact: true })).toHaveAccessibleDescription('执行端')
  })
})

describe('action menu', () => {
  it('opens from its trigger with focus on the first item and puts a destructive item last, after a separator', async () => {
    const renamed = vi.fn()
    const screen = await render(
      <Menu
        label="会话操作"
        align="end"
        sections={[
          {
            id: 'actions',
            items: [
              { id: 'delete', label: '删除…', icon: Trash2, danger: true, onSelect: () => {} },
              { id: 'rename', label: '重命名', icon: Pencil, onSelect: renamed },
            ],
          },
        ]}
        trigger={props => <IconButton {...props} label="更多" icon={Ellipsis} />}
      />,
    )
    const trigger = screen.getByRole('button', { name: '更多' })
    trigger.element().focus()
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(screen.getByRole('menuitem', { name: '重命名' })).toHaveFocus()
    const items = Array.from(screen.getByRole('menu').element().querySelectorAll('[role="menuitem"], [role="separator"]'), item =>
      item.getAttribute('role'),
    )
    expect(items).toEqual(['menuitem', 'separator', 'menuitem'])
    await userEvent.keyboard('{Enter}')
    expect(renamed).toHaveBeenCalledOnce()
    expect(focused()).toBe(trigger.element())
  })
})

describe('on phones', () => {
  it('turns a value picker into a bottom sheet with a single-choice list', async () => {
    await page.viewport(390, 844)
    try {
      const screen = await render(<Model />)
      const trigger = screen.getByRole('button', { name: '模型：alpha-large' })
      await expect.element(trigger).toHaveAttribute('aria-haspopup', 'dialog')
      await userEvent.click(trigger)
      const sheet = screen.getByRole('dialog', { name: '模型' })
      await expect.element(sheet).toBeVisible()
      await userEvent.click(screen.getByRole('radio', { name: 'beta-mini' }))
      await expect.element(screen.getByRole('button', { name: '模型：beta-mini' })).toBeVisible()
      await expect.element(screen.getByRole('dialog', { name: '模型' })).not.toBeInTheDocument()
    } finally {
      await page.viewport(1280, 800)
    }
  })

  it('opens the sheet on the current value even when it is not the first, and keeps Tab inside the sheet', async () => {
    await page.viewport(390, 844)
    try {
      const screen = await render(<Ceiling verify={async () => {}} />)
      screen.getByRole('button', { name: '权限：逐项询问' }).element().focus()
      await userEvent.keyboard('{Enter}')
      const current = screen.getByRole('radio', { name: '逐项询问 默认' })
      await expect.element(current).toHaveFocus()
      await expect.element(current).toHaveAttribute('tabindex', '0')
      // The sheet's Tab order is its 取消 and the list's one tab stop; Tab wraps between them.
      await userEvent.keyboard('{Tab}')
      await expect.element(screen.getByRole('button', { name: '取消' })).toHaveFocus()
      await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
      await expect.element(current).toHaveFocus()
    } finally {
      await page.viewport(1280, 800)
    }
  })

  it("lines a sheet's footer note up with its list: the lock under the radios, the text on the titles", async () => {
    await page.viewport(390, 844)
    try {
      const screen = await render(<Ceiling verify={async () => {}} />)
      await userEvent.click(screen.getByRole('button', { name: '权限：逐项询问' }))
      const sheet = screen.getByRole('dialog', { name: '权限' }).element()
      await expect.element(screen.getByRole('radio', { name: '逐项询问 默认' })).toHaveFocus()
      const note = sheet.querySelector('.ui-menu-footer-note')
      expect(centre(note?.querySelector('.lucide-lock') ?? null)).toBe(centre(sheet.querySelector('.ui-choice-radio')))
      expect(left(note?.querySelector('.ui-menu-footer-text') ?? null)).toBe(left(sheet.querySelector('.ui-choice-title')))
    } finally {
      await page.viewport(1280, 800)
    }
  })

  it('keeps the 默认 badge and the header of the permission menu in the phone sheet', async () => {
    await page.viewport(390, 844)
    try {
      const screen = await render(<Ceiling verify={async () => {}} />)
      await userEvent.click(screen.getByRole('button', { name: '权限：逐项询问' }))
      const current = screen.getByRole('radio', { name: '逐项询问 默认', exact: true })
      await expect.element(current).toHaveFocus()
      expect(current.element().querySelector('.ui-badge')?.textContent).toBe('默认')
      await expect.element(screen.getByRole('radio', { name: '只读', exact: true })).toBeInTheDocument()
      // Whom the levels apply to heads the list and names its radio group, as the menu's header does.
      await expect.element(screen.getByRole('heading', { name: '在这台电脑上发起的会话' })).toBeVisible()
      await expect.element(screen.getByRole('radiogroup', { name: '在这台电脑上发起的会话' })).toBeInTheDocument()
    } finally {
      await page.viewport(1280, 800)
    }
  })

  it('parts the rows of a settings card with a hairline that starts at the text', async () => {
    await page.viewport(390, 844)
    try {
      const screen = await render(
        <div>
          <ValuePicker variant="row" label="模型" value="alpha" options={MODELS} onValueChange={() => {}} />
          <PermissionMenu variant="row" label="权限" levels={LEVELS} value="L1" onValueChange={() => {}} />
        </div>,
      )
      const [first, second] = Array.from(screen.container.querySelectorAll('.ui-value-picker'))
      expect(first && getComputedStyle(first, '::before').content).toBe('none')
      const line = getComputedStyle(second ?? document.body, '::before')
      expect([line.top, line.left, line.height, line.backgroundColor]).toEqual(['0px', '16px', '1px', 'rgba(29, 28, 26, 0.06)'])
    } finally {
      await page.viewport(1280, 800)
    }
  })
})
