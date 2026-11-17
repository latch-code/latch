import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { press } from './helpers.ts'

import {
  IconButton,
  Menu,
  MenuFooterLink,
  MenuFooterNote,
  MenuPanel,
  PanelTabs,
  Popover,
  Tile,
  ValuePicker,
  useLayerClose,
  AlertGlyph,
  CopyGlyph,
  MoreGlyph,
  InfoGlyph,
  EditGlyph,
  PlusGlyph,
  PluginsGlyph,
  ShieldGlyph,
  TrashGlyph,
  UndoGlyph,
  Badge,
  type ValuePickerProps,
} from '../src/index.ts'
import { keepsNativeMenu } from '../src/menu.tsx'

/** Ordered permission levels as a value picker, the way a page lists them: a consequence a line, 默认 on the default. */
interface PermissionLevel<T extends string> {
  value: T
  title: string
  description: string
  risk?: boolean
  disabledReason?: string
}
function PermissionMenu<T extends string>({
  levels,
  defaultValue,
  reserve,
  ...props
}: Omit<ValuePickerProps<T>, 'options' | 'groups' | 'searchable' | 'width'> & { levels: Array<PermissionLevel<T>>; defaultValue?: T }) {
  const start = (props.align ?? (props.size === 'xs' || props.bleed !== undefined ? 'end' : 'start')) === 'start'
  return (
    <ValuePicker
      {...props}
      reserve={reserve ?? start}
      width="sm"
      options={levels.map(level => ({
        value: level.value,
        label: level.title,
        description: level.description,
        ...(level.risk ? { risk: true } : {}),
        ...(level.disabledReason ? { disabledReason: level.disabledReason } : {}),
        ...(level.value === defaultValue ? { tag: <Badge>默认</Badge> } : {}),
      }))}
    />
  )
}

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

describe('ValuePicker placement', () => {
  it('caps its panel at maxHeight', async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ value: `m${index}`, label: `模型 ${index}` }))
    const screen = await render(<ValuePicker label="模型" value="m0" options={many} maxHeight={200} onValueChange={() => {}} />)
    await screen.getByRole('button', { name: /模型/u }).click()
    await expect.poll(() => document.querySelector<HTMLElement>('.ui-popover:popover-open')?.style.maxHeight).toBe('200px')
  })
})

describe('value picker', () => {
  it('keeps the whole accessible description when an option uses markup', async () => {
    const screen = await render(
      <ValuePicker
        label="Harness"
        value="sample"
        options={[
          {
            value: 'sample',
            label: 'Sample',
            description: (
              <span>
                <span>/tools/bin/</span>
                <span>agent</span>
              </span>
            ),
          },
          { value: 'other', label: 'Other' },
        ]}
        onValueChange={() => {}}
      />,
    )
    await screen.getByRole('button', { name: 'Harness：Sample' }).click()
    await expect.element(screen.getByRole('menuitemradio', { name: 'Sample' })).toHaveAccessibleDescription('/tools/bin/agent')
  })

  it.each(['hidden', 'inert', 'visibility'] as const)('does not open a modal for a request on a %s retained page', async hiddenBy => {
    const picker = (request: number, covered = true) => (
      <div
        hidden={covered && hiddenBy === 'hidden'}
        inert={covered && hiddenBy === 'inert'}
        style={covered && hiddenBy === 'visibility' ? { visibility: 'hidden' } : undefined}>
        <ValuePicker variant="row" label="项目" value="alpha" options={MODELS} openRequest={request} onValueChange={() => {}} />
      </div>
    )
    const screen = await render(picker(0))
    await screen.rerender(picker(1))
    expect(document.querySelectorAll('dialog:modal')).toHaveLength(0)
    await screen.rerender(picker(1, false))
    expect(document.querySelectorAll('dialog:modal')).toHaveLength(0)
    await screen.rerender(picker(2, false))
    await screen.getByRole('radio', { name: 'beta-mini' }).click()
    await expect.element(screen.getByRole('button', { name: '项目：alpha-large' })).toHaveFocus()
    expect(document.querySelectorAll('dialog:modal')).toHaveLength(0)
  })

  it('reports a current value only when the caller explicitly enables reselect', async () => {
    const picked = vi.fn()
    const screen = await render(<ValuePicker label="模型" value="alpha" options={MODELS} onValueChange={picked} />)
    await screen.getByRole('button', { name: '模型：alpha-large' }).click()
    await screen.getByRole('menuitemradio', { name: 'alpha-large' }).click()
    expect(picked).not.toHaveBeenCalled()
    await screen.rerender(<ValuePicker label="模型" value="alpha" options={MODELS} onValueChange={picked} reselect />)
    await screen.getByRole('button', { name: '模型：alpha-large' }).click()
    await screen.getByRole('menuitemradio', { name: 'alpha-large' }).click()
    expect(picked).toHaveBeenCalledExactlyOnceWith('alpha')
    await expect.element(screen.getByRole('button', { name: '模型：alpha-large' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens a requested search, keeps typing local and accepts a later new request', async () => {
    const request = { query: 'beta', revision: 1 }
    const picker = (searchRequest = request) => (
      <ValuePicker label="模型" value="alpha" options={MODELS} onValueChange={() => {}} searchable searchRequest={searchRequest} />
    )
    const screen = await render(picker())
    await expect.element(screen.getByRole('searchbox')).toHaveValue('beta')
    await expect.element(screen.getByRole('menuitemradio', { name: 'beta-mini' })).toBeVisible()
    await screen.getByRole('searchbox').fill('delta')
    await screen.rerender(picker())
    await expect.element(screen.getByRole('searchbox')).toHaveValue('delta')
    await screen.rerender(picker({ query: 'alpha', revision: 2 }))
    await expect.element(screen.getByRole('searchbox')).toHaveValue('alpha')
  })

  it('repairs a removed focused option after a refresh and still closes on Escape', async () => {
    const screen = await render(<ValuePicker label="模型" value="alpha" options={MODELS} onValueChange={() => {}} />)
    await screen.getByRole('button', { name: '模型：alpha-large' }).click()
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(screen.getByRole('menuitemradio', { name: 'beta-mini' })).toHaveFocus()
    await screen.rerender(
      <ValuePicker
        label="模型"
        value="new"
        options={[
          { value: 'new', label: '新模型' },
          { value: 'other', label: '其他模型' },
        ]}
        onValueChange={() => {}}
      />,
    )
    await expect.element(screen.getByRole('menuitemradio', { name: '新模型' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('button', { name: '模型：新模型' })).toHaveAttribute('aria-expanded', 'false')
    await expect.element(screen.getByRole('button', { name: '模型：新模型' })).toHaveFocus()
  })

  it('leaves surviving option, search and outside focus alone when options refresh', async () => {
    const picker = (extra = false) => (
      <>
        <ValuePicker
          label="模型"
          value="alpha"
          options={extra ? [...MODELS, { value: 'new', label: '新模型' }] : MODELS}
          searchable
          onValueChange={() => {}}
        />
        <button type="button">其他控件</button>
      </>
    )
    const screen = await render(picker())
    await screen.getByRole('button', { name: '模型：alpha-large' }).click()
    await userEvent.keyboard('{ArrowDown}')
    const option = screen.getByRole('menuitemradio', { name: 'beta-mini' })
    await expect.element(option).toHaveFocus()
    await screen.rerender(picker(true))
    await expect.element(option).toHaveFocus()
    screen.getByRole('searchbox').element().focus()
    await screen.rerender(picker())
    await expect.element(screen.getByRole('searchbox')).toHaveFocus()
    screen.getByRole('button', { name: '其他控件' }).element().focus()
    await screen.rerender(picker(true))
    await expect.element(screen.getByRole('button', { name: '其他控件' })).toHaveFocus()
  })

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
    expect(screen.container.querySelector('.latch-glyph-up-down')).toBeNull()
  })

  it('ends in chevrons-up-down and writes an unchosen value in muted ink, never in a warning colour', async () => {
    const screen = await render(
      <ValuePicker label="模型" value={undefined} placeholder="选择模型" options={MODELS} onValueChange={() => {}} />,
    )
    const trigger = screen.getByRole('button', { name: '模型：选择模型' })
    expect(trigger.element().querySelector('.latch-glyph-up-down')).not.toBeNull()
    expect(trigger.element().querySelector('.latch-glyph-chevron-down')).toBeNull()
    const text = trigger.element().querySelector('.ui-value-picker-text[data-shown]')
    expect(text && getComputedStyle(text).color).toBe('rgb(86, 86, 95)')
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
      leading={ShieldGlyph}
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
        <PermissionMenu label="工具栏权限" leading={ShieldGlyph} levels={LEVELS} value="L0" onValueChange={() => {}} />
        <PermissionMenu label="设置行权限" align="end" levels={LEVELS} value="L3" onValueChange={() => {}} />
        <ValuePicker label="模型" value="alpha" options={MODELS} onValueChange={() => {}} />
        <ValuePicker label="项目" leading={ShieldGlyph} value="L0" options={SHORT_LEVELS} onValueChange={() => {}} />
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
    expect(menu.element().querySelector('.latch-glyph-shield-alert')).toBeNull()
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
    const shield = screen.getByRole('button', { name: '权限：完全访问' }).element().querySelector('.latch-glyph-shield-alert')
    expect(shield && getComputedStyle(shield).color).toBe('rgb(196, 111, 6)')
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
    expect(Math.abs(middle(chosen.querySelector('.latch-glyph-check')) - middle(chosen.querySelector('.ui-menu-item-title')))).toBeLessThan(
      1,
    )
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
      // Whole pixels; a sub-pixel offset of the trigger's text may round to -0.
      const result = {
        start: Math.round(rect(layer).left - rect(trigger.element()).left) + 0,
        end: Math.round(rect(layer).right - rect(trigger.element()).right) + 0,
      }
      await userEvent.keyboard('{Escape}')
      return result
    }
    expect((await edges('检查器权限')).end).toBe(0)
    expect((await edges('设置行权限')).end).toBe(0)
    expect((await edges('工具栏权限')).start).toBe(0)
  })

  it('reserves the leading slot only when a check or a glyph can fill it', async () => {
    const screen = await render(
      <div>
        <div className="ui-popover">
          <MenuPanel
            label="更多批准选项"
            sections={[
              { id: 'more', items: [{ id: 'always', label: '本会话始终允许', description: '只在这个会话里有效', onSelect: () => {} }] },
            ]}
            footer={<MenuFooterLink onClick={() => {}}>管理…</MenuFooterLink>}
          />
        </div>
        <div className="ui-popover">
          <MenuPanel
            label="会话"
            sections={[{ id: 'actions', items: [{ id: 'rename', label: '重命名', icon: EditGlyph, onSelect: () => {} }] }]}
          />
        </div>
      </div>,
    )
    const [plain, glyphs] = Array.from(screen.container.querySelectorAll<HTMLElement>('.ui-menu'))
    const item = plain.querySelector<HTMLElement>('.ui-menu-item')!
    const padding = parseFloat(getComputedStyle(item).paddingLeft)
    // A plain action starts at the item's padding, and so does the footer link under it.
    expect(left(plain.querySelector('.ui-menu-item-title'))).toBeCloseTo(item.getBoundingClientRect().left + padding, 0)
    expect(left(plain.querySelector('.ui-menu-footer-text'))).toBeCloseTo(left(plain.querySelector('.ui-menu-item-title')) ?? 0, 0)
    expect(getComputedStyle(plain.querySelector('.ui-menu-item-lead')!).display).toBe('none')
    // With a glyph the slot stays, 16 wide and 8 before the title.
    const lead = glyphs.querySelector<HTMLElement>('.ui-menu-item-lead')!
    expect(lead.getBoundingClientRect().width).toBe(16)
    expect(left(glyphs.querySelector('.ui-menu-item-title'))).toBeCloseTo(lead.getBoundingClientRect().right + 8, 0)
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
                  { id: 'rename', label: '重命名', icon: EditGlyph, onSelect: () => {} },
                  { id: 'delete', label: '删除…', icon: TrashGlyph, danger: true, onSelect: () => {} },
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
    expect(centre(note?.querySelector('.latch-glyph-lock') ?? null)).toBe(centre(actions?.querySelector('.ui-menu-item-lead') ?? null))
    const danger = screen.getByRole('menuitem', { name: '删除…' }).element()
    expect(getComputedStyle(danger.querySelector('.latch-glyph-trash')!).color).toBe(getComputedStyle(danger).color)
    expect(getComputedStyle(danger).color).toBe('rgb(180, 35, 31)')
  })

  it('draws a footer note with the lock unless it is no restriction, which keeps its own glyph in the same slot', async () => {
    const screen = await render(
      <div>
        {[undefined, InfoGlyph, AlertGlyph].map((icon, index) => (
          <div key={index} className="ui-popover">
            <MenuPanel
              label={`文件 ${index}`}
              header={{ title: 'deck.pptx' }}
              sections={[{ id: 'copy', items: [{ id: 'copy', label: '复制路径', icon: CopyGlyph, onSelect: () => {} }] }]}
              footer={icon ? <MenuFooterNote icon={icon}>说明</MenuFooterNote> : <MenuFooterNote>说明</MenuFooterNote>}
            />
          </div>
        ))}
      </div>,
    )
    const notes = Array.from(screen.container.querySelectorAll('.ui-menu-footer-note'))
    expect(notes.map(note => note.querySelector('svg')?.getAttribute('class'))).toEqual([
      expect.stringContaining('latch-glyph-lock'),
      expect.stringContaining('latch-glyph-info'),
      expect.stringContaining('latch-glyph-alert'),
    ])
    for (const note of notes) {
      const menu = note.closest('.ui-menu')!
      expect(centre(note.querySelector('svg'))).toBe(centre(menu.querySelector('.ui-menu-item-lead')))
    }
  })

  it('turns an action glyph from muted to ink while its item is hovered, and keeps a destructive glyph red', async () => {
    const screen = await render(
      <div className="ui-popover">
        <MenuPanel
          label="会话"
          sections={[
            {
              id: 'actions',
              items: [
                { id: 'rename', label: '重命名', icon: EditGlyph, onSelect: () => {} },
                { id: 'delete', label: '删除…', icon: TrashGlyph, danger: true, onSelect: () => {} },
              ],
            },
          ]}
        />
      </div>,
    )
    const rename = screen.getByRole('menuitem', { name: '重命名' })
    const glyph = () => getComputedStyle(rename.element().querySelector('.latch-glyph-edit')!).color
    expect(glyph()).toBe('rgb(86, 86, 95)')
    await userEvent.hover(rename)
    await expect.poll(glyph).toBe(getComputedStyle(document.documentElement).color)
    const danger = screen.getByRole('menuitem', { name: '删除…' })
    await userEvent.hover(danger)
    expect(getComputedStyle(danger.element().querySelector('.latch-glyph-trash')!).color).toBe('rgb(180, 35, 31)')
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
              { id: 'delete', label: '删除…', icon: TrashGlyph, danger: true, onSelect: () => {} },
              { id: 'rename', label: '重命名', icon: EditGlyph, onSelect: renamed },
            ],
          },
        ]}
        trigger={props => <IconButton {...props} label="更多" icon={MoreGlyph} />}
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

describe('menu accelerators', () => {
  it('shows each item its letter at the end and chooses it with that key while open, never a disabled one', async () => {
    const browser = vi.fn()
    const blocked = vi.fn()
    const screen = await render(
      <Menu
        label="打开面板"
        sections={[
          {
            id: 'open',
            items: [
              { id: 'browser', label: '浏览器', icon: PlusGlyph, accelerator: 'B', onSelect: browser },
              { id: 'files', label: '文件', icon: PlusGlyph, accelerator: 'F', disabledReason: '读不到', onSelect: blocked },
            ],
          },
        ]}
        trigger={props => <IconButton {...props} label="打开" icon={PlusGlyph} />}
      />,
    )
    const trigger = screen.getByRole('button', { name: '打开' })
    trigger.element().focus()
    await userEvent.keyboard('{ArrowDown}')
    const item = screen.getByRole('menuitem', { name: '浏览器' })
    expect(item.element().getAttribute('aria-keyshortcuts')).toBe('B')
    expect(item.element().querySelector('.ui-kbd')?.textContent).toBe('B')
    await userEvent.keyboard('f')
    expect(blocked).not.toHaveBeenCalled()
    await expect.element(screen.getByRole('menu')).toBeVisible()
    await userEvent.keyboard('b')
    expect(browser).toHaveBeenCalledOnce()
    expect(focused()).toBe(trigger.element())
  })
})

describe('panel tabs add slot', () => {
  it('stands right after the tabs, before the actions at the row end', async () => {
    const screen = await render(
      <div style={{ width: '480px' }}>
        <PanelTabs
          label="面板"
          value="a"
          onValueChange={() => {}}
          tabs={[{ value: 'a', label: '改动' }]}
          add={<IconButton label="打开面板" icon={PlusGlyph} size="xs" />}
          actions={<IconButton label="铺满" icon={MoreGlyph} size="xs" />}
        />
      </div>,
    )
    const tab = screen.getByRole('tab', { name: '改动' }).element().getBoundingClientRect()
    const add = screen.getByRole('button', { name: '打开面板' }).element().getBoundingClientRect()
    const end = screen.getByRole('button', { name: '铺满' }).element().getBoundingClientRect()
    expect(add.left).toBeGreaterThanOrEqual(tab.right)
    expect(add.left - tab.right).toBeLessThan(24)
    expect(end.left - add.right).toBeGreaterThan(200)
  })
})

describe('a popover', () => {
  it('hands focus to its first meaningful control on opening, never to a close button, and back to its trigger', async () => {
    const screen = await render(
      <Popover
        label="额度"
        trigger={props => (
          <button {...props} type="button">
            额度
          </button>
        )}>
        <button type="button" data-layer-close="">
          关闭
        </button>
        <button type="button">用量</button>
      </Popover>,
    )
    await userEvent.click(screen.getByRole('button', { name: '额度' }))
    await expect.element(screen.getByRole('button', { name: '用量' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('button', { name: '额度' })).toHaveFocus()
  })

  it('takes a width from the layer scale only', async () => {
    const screen = await render(
      <Popover
        label="宽度"
        size="md"
        trigger={props => (
          <button {...props} type="button">
            宽度
          </button>
        )}>
        <p>内容</p>
      </Popover>,
    )
    await userEvent.click(screen.getByRole('button', { name: '宽度' }))
    await expect.poll(() => document.querySelector('.ui-popover:popover-open')?.getBoundingClientRect().width).toBe(400)
  })
})

describe('on phones', () => {
  it('shows a popover as a sheet titled with its title, closed by the one close button every sheet has', async () => {
    await page.viewport(390, 844)
    try {
      const screen = await render(
        <Popover
          label="计划"
          title="计划 1/2"
          trigger={props => (
            <button {...props} type="button">
              计划
            </button>
          )}>
          <p>读取设置页的保存逻辑</p>
        </Popover>,
      )
      await userEvent.click(screen.getByRole('button', { name: '计划' }))
      const sheet = screen.getByRole('dialog', { name: '计划 1/2' })
      await expect.element(sheet).toBeVisible()
      expect(sheet.element().querySelectorAll('.ui-sheet-header button')).toHaveLength(1)
      await userEvent.click(screen.getByRole('button', { name: '关闭' }))
      await expect.element(screen.getByRole('dialog', { name: '计划 1/2' })).not.toBeInTheDocument()
    } finally {
      await page.viewport(1280, 800)
    }
  })

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

  it('closes the sheet when the value already chosen is pressed, without changing it', async () => {
    await page.viewport(390, 844)
    try {
      let changes = 0
      const screen = await render(<ValuePicker label="模型" value="alpha" options={MODELS} onValueChange={() => void changes++} />)
      await userEvent.click(screen.getByRole('button', { name: /^模型：/u }))
      await expect.element(screen.getByRole('dialog', { name: '模型' })).toBeVisible()
      await userEvent.click(screen.getByRole('radio', { checked: true }))
      await expect.element(screen.getByRole('dialog', { name: '模型' })).not.toBeInTheDocument()
      expect(changes).toBe(0)
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
      // The sheet's Tab order is its close button and the list's one tab stop; Tab wraps between them.
      await userEvent.keyboard('{Tab}')
      await expect.element(screen.getByRole('button', { name: '关闭' })).toHaveFocus()
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
      expect(centre(note?.querySelector('.latch-glyph-lock') ?? null)).toBe(centre(sheet.querySelector('.ui-choice-radio')))
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
      expect([line.top, line.left, line.height, line.backgroundColor]).toEqual(['0px', '16px', '1px', 'rgba(18, 18, 28, 0.075)'])
    } finally {
      await page.viewport(1280, 800)
    }
  })
})

/** A small form shown in a picker's layer in place of its menu; saving adds a value and closes the layer. */
function AddForm({ onSave }: { onSave: (value: string) => void }) {
  const close = useLayerClose()
  return (
    <form
      aria-label="添加模型"
      onSubmit={event => {
        event.preventDefault()
        onSave('epsilon')
        close()
      }}>
      <input aria-label="模型 ID" />
      <button type="submit">保存并使用</button>
    </form>
  )
}

/** A picker whose footer can undo a pending value and turn the layer into a small form that adds one. */
function Adding({ onOpenChange }: { onOpenChange?: (open: boolean) => void }) {
  const [value, setValue] = useState('alpha')
  const [extra, setExtra] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const pending = value !== 'alpha'
  return (
    <ValuePicker
      label="模型"
      value={value}
      valueText={pending ? `下一条：${value}` : undefined}
      groups={[
        {
          id: 'local',
          label: '本地',
          media: <Tile size={16} icon={PluginsGlyph} />,
          options: [...MODELS, ...extra.map(item => ({ value: item, label: item }))].map(option => ({
            ...option,
            media: <Tile size={16} icon={PluginsGlyph} />,
          })),
        },
      ]}
      onValueChange={setValue}
      onOpenChange={open => {
        if (!open) setAdding(false)
        onOpenChange?.(open)
      }}
      footer={
        <>
          {pending && (
            <MenuFooterLink
              icon={UndoGlyph}
              chevron={false}
              closes
              onClick={() => {
                setValue('alpha')
              }}>
              撤销切换
            </MenuFooterLink>
          )}
          <MenuFooterLink
            icon={PlusGlyph}
            chevron={false}
            onClick={() => {
              setAdding(true)
            }}>
            添加模型…
          </MenuFooterLink>
        </>
      }
      panel={
        adding ? (
          <AddForm
            onSave={item => {
              setExtra([item])
              setValue(item)
            }}
          />
        ) : undefined
      }
    />
  )
}

describe('value picker extras', () => {
  it("draws each value's tile after the check slot and the group's tile before its heading", async () => {
    const screen = await render(<Adding />)
    await screen.getByRole('button', { name: '模型：alpha-large' }).click()
    const item = screen.getByRole('menuitemradio', { name: 'alpha-large' }).element()
    expect(item.hasAttribute('data-media')).toBe(true)
    const [lead, media, text] = Array.from(item.children)
    expect([lead?.className, media?.className, text?.className]).toEqual(['ui-menu-item-lead', 'ui-menu-item-media', 'ui-menu-item-text'])
    expect(rect(lead).right).toBeLessThan(rect(media).left)
    expect(rect(media).right).toBeLessThan(rect(text).left)
    expect(document.querySelector('.ui-menu-section-label .ui-tile')).not.toBeNull()
  })

  it('shows a pending value in its own words, and undoes it from a footer action that closes the menu', async () => {
    const screen = await render(<Adding />)
    await screen.getByRole('button', { name: '模型：alpha-large' }).click()
    await screen.getByRole('menuitemradio', { name: 'beta-mini' }).click()
    const pending = screen.getByRole('button', { name: '模型：下一条：beta' })
    await expect.element(pending).toBeVisible()
    await pending.click()
    const undo = screen.getByRole('menuitem', { name: '撤销切换' })
    // An action that stays here has its glyph in the leading slot and no chevron.
    expect(undo.element().querySelectorAll('.ui-icon')).toHaveLength(1)
    await undo.click()
    await expect.element(screen.getByRole('button', { name: '模型：alpha-large' })).toHaveAttribute('aria-expanded', 'false')
  })

  it("turns its layer into a form in the menu's place that stays open, closes from inside, and reports every opening and closing", async () => {
    const changes: boolean[] = []
    const screen = await render(
      <Adding
        onOpenChange={open => {
          changes.push(open)
        }}
      />,
    )
    const trigger = screen.getByRole('button', { name: '模型：alpha-large' })
    await trigger.click()
    await screen.getByRole('menuitem', { name: '添加模型…' }).click()
    const form = screen.getByRole('form', { name: '添加模型' })
    await expect.element(form).toBeVisible()
    expect(document.querySelector('.ui-popover[data-panel] [role="menu"]')).toBeNull()
    await expect.element(trigger).toHaveAttribute('aria-expanded', 'true')
    await screen.getByRole('textbox', { name: '模型 ID' }).fill('epsilon')
    await screen.getByRole('button', { name: '保存并使用' }).click()
    await expect.element(screen.getByRole('button', { name: '模型：下一条：epsilon' })).toHaveAttribute('aria-expanded', 'false')
    expect(changes).toEqual([true, false])
    // Opened again, it is the menu once more; Escape closes the panel as it closes the menu.
    await screen.getByRole('button', { name: '模型：下一条：epsilon' }).click()
    await screen.getByRole('menuitem', { name: '添加模型…' }).click()
    screen.getByRole('textbox', { name: '模型 ID' }).element().focus()
    await userEvent.keyboard('{Escape}')
    await expect.element(screen.getByRole('button', { name: '模型：下一条：epsilon' })).toHaveAttribute('aria-expanded', 'false')
    await expect.element(screen.getByRole('button', { name: '模型：下一条：epsilon' })).toHaveFocus()
  })
})

/** A picker low in the window whose footer turns the layer into a panel `tall` px high, ending in a button. */
function Reshaping({ tall }: { tall: number }) {
  const [adding, setAdding] = useState(false)
  return (
    <div style={{ position: 'fixed', left: 40, top: 480 }}>
      <ValuePicker
        label="模型"
        value="alpha"
        options={MODELS}
        onValueChange={() => {}}
        width={adding ? 'md' : undefined}
        onOpenChange={open => {
          if (!open) setAdding(false)
        }}
        footer={
          <MenuFooterLink
            icon={PlusGlyph}
            chevron={false}
            onClick={() => {
              setAdding(true)
            }}>
            添加模型…
          </MenuFooterLink>
        }
        panel={
          adding ? (
            <section aria-label="添加模型" style={{ display: 'grid', alignContent: 'space-between', height: tall }}>
              <input aria-label="模型 ID" />
              <button type="button">保存并使用</button>
            </section>
          ) : undefined
        }
      />
    </div>
  )
}

const layerBox = () => document.querySelector<HTMLElement>('.ui-popover:popover-open')?.getBoundingClientRect() ?? new DOMRect()

describe('a layer whose content changes', () => {
  it('is placed again when its menu turns into a taller panel: it flips to the side where the panel fits whole', async () => {
    const screen = await render(<Reshaping tall={400} />)
    await screen.getByRole('button', { name: '模型：alpha-large' }).click()
    await expect.element(screen.getByRole('menu', { name: '模型' })).toBeVisible()
    const layer = document.querySelector<HTMLElement>('.ui-popover:popover-open')!
    expect(layer.dataset.side).toBe('bottom')
    await screen.getByRole('menuitem', { name: '添加模型…' }).click()
    await expect.element(screen.getByRole('region', { name: '添加模型' })).toBeVisible()
    await expect.poll(() => layer.dataset.side).toBe('top')
    expect(layerBox().top).toBeGreaterThanOrEqual(8)
    expect(layerBox().bottom).toBeLessThanOrEqual(480 - 6 + 0.5)
    expect(layerBox().width).toBe(400)
  })

  it('keeps a panel taller than either side inside the window, scrolling within, so its last control can be reached', async () => {
    const screen = await render(<Reshaping tall={600} />)
    await screen.getByRole('button', { name: '模型：alpha-large' }).click()
    await screen.getByRole('menuitem', { name: '添加模型…' }).click()
    await expect.element(screen.getByRole('region', { name: '添加模型' })).toBeVisible()
    await expect.poll(() => layerBox().bottom).toBeLessThanOrEqual(innerHeight - 8 + 0.5)
    const layer = document.querySelector<HTMLElement>('.ui-popover:popover-open')!
    // The side it was on still has more than a menu's worth of room, so it stays there and scrolls.
    expect(layer.dataset.side).toBe('bottom')
    expect(layer.scrollHeight).toBeGreaterThan(layer.clientHeight)
    const last = screen.getByRole('button', { name: '保存并使用' }).element()
    last.scrollIntoView({ block: 'nearest' })
    const box = last.getBoundingClientRect()
    expect(box.bottom).toBeLessThanOrEqual(layerBox().bottom)
    expect(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)).toBe(last)
  })
})

it('lets a value picker use a domain-specific search without changing labels', async () => {
  const screen = await render(
    <ValuePicker
      label="模型模糊搜索"
      value={undefined}
      options={MODELS}
      onValueChange={() => {}}
      searchable
      searchMatch={(option, query) => option.value.startsWith(query.slice(0, 1))}
    />,
  )
  await screen.getByRole('button', { name: /模型模糊搜索/u }).click()
  await page.getByRole('searchbox').fill('bm')
  await expect.element(page.getByRole('menuitemradio', { name: 'beta-mini', exact: true })).toBeVisible()
  await expect.element(page.getByRole('menuitemradio', { name: 'alpha-large', exact: true })).not.toBeInTheDocument()
  await userEvent.keyboard('{Escape}{Escape}')
})

describe("a row's context menu", () => {
  function Row({ onRename, onOpen }: { onRename: () => void; onOpen: () => void }) {
    return (
      <div className="row" data-testid="row">
        <button type="button" onClick={onOpen}>
          会话一
        </button>
        <input aria-label="备注" defaultValue="可复制的字" />
        <Menu
          label="会话操作"
          context={trigger => trigger?.closest('.row') ?? null}
          sections={[
            { id: 'edit', items: [{ id: 'rename', label: '重命名', onSelect: onRename }] },
            { id: 'danger', items: [{ id: 'delete', label: '删除', danger: true, onSelect() {} }] },
          ]}
          trigger={props => <IconButton {...props} size="xs" label="更多操作" icon={MoreGlyph} />}
        />
      </div>
    )
  }

  it('opens the same menu as its ⋯ at the pointer on right click, and the same items from the keyboard', async () => {
    const rename = vi.fn()
    const screen = await render(<Row onRename={rename} onOpen={() => {}} />)
    const row = screen.getByTestId('row').element()
    await screen.getByRole('button', { name: '更多操作' }).click()
    const fromTrigger = [...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)
    await userEvent.keyboard('{Escape}')
    const box = row.getBoundingClientRect()
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: box.left + 40,
      clientY: box.top + 4,
      button: 2,
    })
    row.querySelector('button')!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await expect.element(page.getByRole('menuitem', { name: '重命名' })).toBeVisible()
    expect([...document.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(fromTrigger)
    const layer = document.querySelector<HTMLElement>('.ui-popover:popover-open')!.getBoundingClientRect()
    expect(Math.abs(layer.left - (box.left + 40))).toBeLessThanOrEqual(2)
    await page.getByRole('menuitem', { name: '重命名' }).click()
    expect(rename).toHaveBeenCalledTimes(1)
    row.querySelector('button')!.focus()
    await userEvent.keyboard('{Shift>}{F10}{/Shift}')
    await expect.element(page.getByRole('menuitem', { name: '重命名' })).toBeVisible()
    await userEvent.keyboard('{Escape}')
    expect(document.activeElement).toBe(row.querySelector('button'))
  })

  it('leaves the browser menu on text: a field, and a selection', async () => {
    const screen = await render(<Row onRename={() => {}} onOpen={() => {}} />)
    const input = screen.getByRole('textbox', { name: '备注' }).element()
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    input.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(keepsNativeMenu(input, null)).toBe(true)
    const label = screen.getByRole('button', { name: '会话一' }).element()
    expect(keepsNativeMenu(label, null)).toBe(false)
    const selection = getSelection()!
    selection.selectAllChildren(label)
    expect(keepsNativeMenu(label, selection)).toBe(true)
    selection.removeAllRanges()
    // The terminal's screen has its own menu, even on the hidden input xterm moves under the pointer.
    const xterm = document.createElement('div')
    xterm.className = 'xterm'
    const helper = document.createElement('textarea')
    xterm.append(helper)
    expect(keepsNativeMenu(helper, null)).toBe(false)
  })

  it('opens on a press and hold by touch, and the release does not also press the row', async () => {
    const opened = vi.fn()
    const screen = await render(<Row onRename={() => {}} onOpen={opened} />)
    const target = screen.getByRole('button', { name: '会话一' }).element() as HTMLButtonElement
    const box = target.getBoundingClientRect()
    const at = { bubbles: true, pointerType: 'touch', clientX: box.left + 4, clientY: box.top + 4 }
    target.dispatchEvent(new PointerEvent('pointerdown', at))
    await new Promise(done => setTimeout(done, 600))
    target.dispatchEvent(new PointerEvent('pointerup', at))
    target.click()
    await expect.element(page.getByRole('menuitem', { name: '重命名' })).toBeVisible()
    expect(opened).not.toHaveBeenCalled()
  })
})
