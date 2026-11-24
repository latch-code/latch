import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import {
  Button,
  Checkbox,
  Radio,
  ChoiceList,
  DevMark,
  FilterPills,
  SegmentedControl,
  Switch,
  SwitchRow,
  Tabs,
  ValuePicker,
  type ChoiceOption,
} from '../src/index.ts'
import { press } from './helpers.ts'

const style = (element: Element, pseudo?: string) => getComputedStyle(element, pseudo)
/** The vertical centre of an element's box. */
const middle = (element: Element | null) => {
  const box = element?.getBoundingClientRect() ?? new DOMRect()
  return box.top + box.height / 2
}
/** How many controls of a group take a Tab stop. */
const tabStops = (group: Element) => Array.from(group.querySelectorAll('button')).filter(button => button.tabIndex === 0).length

function Toggle({ disabled = false }: { disabled?: boolean }) {
  const [on, setOn] = useState(false)
  return <Switch label="允许其他设备" checked={on} disabled={disabled} onCheckedChange={setOn} />
}

describe('switch', () => {
  it('keeps the off thumb and red action visible with the dark monochrome accent', async () => {
    const { dataset } = document.documentElement
    const { theme, deviceAccent } = dataset
    try {
      dataset.theme = 'dark'
      dataset.deviceAccent = 'workbench'
      const screen = await render(
        <>
          <Toggle />
          <Button variant="destroy" keys={['⌫']}>
            删除
          </Button>
        </>,
      )
      const toggle = screen.getByRole('switch').element()
      const thumb = toggle.querySelector('.ui-switch-thumb')!
      const destroy = screen.getByRole('button', { name: '删除' }).element()
      const key = destroy.querySelector('.ui-kbd')!
      expect([style(thumb).backgroundColor, style(destroy).backgroundColor, style(destroy).color, style(key).color]).toEqual([
        'rgb(255, 255, 255)',
        'rgb(220, 38, 38)',
        'rgb(255, 255, 255)',
        'rgb(255, 255, 255)',
      ])
      await press(screen.getByRole('switch'))
      await expect.poll(() => style(thumb).backgroundColor).toBe('rgb(25, 25, 25)')
      await expect.poll(() => style(toggle, '::before').backgroundColor).toBe('rgb(231, 231, 231)')
    } finally {
      if (theme === undefined) delete dataset.theme
      else dataset.theme = theme
      if (deviceAccent === undefined) delete dataset.deviceAccent
      else dataset.deviceAccent = deviceAccent
    }
  })

  it('is a 34×20 switch that Space toggles, the track grey when off and the accent when on, its white thumb sliding over --m-micro', async () => {
    const screen = await render(<Toggle />)
    const toggle = screen.getByRole('switch', { name: '允许其他设备' })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    const off = style(toggle.element(), '::before')
    expect([off.width, off.height, off.backgroundColor]).toEqual(['34px', '20px', 'rgba(18, 18, 28, 0.11)'])
    const thumb = toggle.element().querySelector('.ui-switch-thumb')!
    expect([style(thumb).width, style(thumb).backgroundColor, style(thumb).transitionDuration]).toEqual([
      '16px',
      'rgb(255, 255, 255)',
      '0.12s, 0.12s',
    ])
    await userEvent.tab()
    await userEvent.keyboard(' ')
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => style(toggle.element(), '::before').backgroundColor).toBe('rgb(36, 97, 224)')
    await expect.poll(() => style(thumb).translate).toBe('14px')
  })

  it('rings the track on keyboard focus, so the ring follows the pill and not the box around it', async () => {
    const screen = await render(<Toggle />)
    await userEvent.tab()
    const toggle = screen.getByRole('switch', { name: '允许其他设备' }).element()
    expect(document.activeElement).toBe(toggle)
    expect(style(toggle).outlineStyle).toBe('none')
    const track = style(toggle, '::before')
    expect([track.outlineStyle, track.outlineWidth, track.outlineOffset, track.borderTopLeftRadius]).toEqual([
      'solid',
      '2px',
      '2px',
      '999px',
    ])
  })

  it('stays focusable when disabled and does not toggle', async () => {
    const screen = await render(<Toggle disabled />)
    const toggle = screen.getByRole('switch')
    press(toggle)
    await expect.element(toggle).toHaveAttribute('aria-checked', 'false')
    await userEvent.tab()
    await expect.element(toggle).toHaveFocus()
  })

  it('makes the whole row its label, and keeps a switch that policy locks off with the reason', async () => {
    const changed = vi.fn()
    const screen = await render(
      <div>
        <SwitchRow
          title="允许其他设备在这里新建会话"
          description="关闭后只能查看、批准或停止已有会话"
          checked={false}
          onCheckedChange={changed}
        />
        <SwitchRow title="验收模型插件" checked locked="已由本机策略关闭，无法在这里开启" onCheckedChange={changed} />
      </div>,
    )
    await userEvent.click(screen.getByText('允许其他设备在这里新建会话'))
    expect(changed).toHaveBeenCalledWith(true)
    const row = screen.getByRole('switch', { name: '允许其他设备在这里新建会话' })
    await expect.element(row).toHaveAccessibleDescription('关闭后只能查看、批准或停止已有会话')
    const locked = screen.getByRole('switch', { name: '验收模型插件' })
    await expect.element(locked).toHaveAttribute('aria-checked', 'false')
    await expect.element(locked).toHaveAttribute('aria-disabled', 'true')
    await expect.element(locked).toHaveAccessibleDescription('已由本机策略关闭，无法在这里开启')
    changed.mockClear()
    press(screen.getByText('验收模型插件'))
    expect(changed).not.toHaveBeenCalled()
  })
})

function Modes({ third = false }: { third?: boolean }) {
  const [mode, setMode] = useState<'chat' | 'agent' | 'plan'>('chat')
  return (
    <SegmentedControl
      label="会话模式"
      value={mode}
      onValueChange={setMode}
      options={
        third
          ? [
              { value: 'chat', label: '对话' },
              { value: 'agent', label: 'Agent', disabled: true },
              { value: 'plan', label: '计划' },
            ]
          : [
              { value: 'chat', label: '对话' },
              { value: 'agent', label: 'Agent' },
            ]
      }
    />
  )
}

describe('segmented control', () => {
  it('chooses none where none is shown, and a press on either goes to it', async () => {
    const chosen = vi.fn()
    const screen = await render(
      <SegmentedControl
        label="地点"
        value={null}
        onValueChange={chosen}
        options={[
          { value: 'code', label: 'Code' },
          { value: 'agents', label: '我的 Agent' },
        ]}
      />,
    )
    await expect.element(screen.getByRole('radio', { name: 'Code' })).toHaveAttribute('aria-checked', 'false')
    await expect.element(screen.getByRole('radio', { name: '我的 Agent' })).toHaveAttribute('aria-checked', 'false')
    expect(tabStops(screen.getByRole('radiogroup', { name: '地点' }).element())).toBe(1)
    await screen.getByRole('radio', { name: 'Code' }).click()
    expect(chosen).toHaveBeenCalledWith('code')
  })
  it("draws a place's glyph before its words and a mark after them, named by the words alone", async () => {
    const screen = await render(
      <SegmentedControl
        label="地点"
        value="code"
        onValueChange={() => {}}
        options={[
          { value: 'code', label: 'Code', icon: <svg data-testid="glyph" aria-hidden="true" /> },
          { value: 'agents', label: '我的 Agent', badge: <span data-testid="dot" aria-hidden="true" />, title: '有等你处理的会话' },
        ]}
      />,
    )
    const agents = screen.getByRole('radio', { name: '我的 Agent' })
    await expect.element(agents).toBeInTheDocument()
    await expect.element(agents).toHaveAccessibleDescription('有等你处理的会话')
    const code = screen.getByRole('radio', { name: 'Code' }).element()
    expect(code.firstElementChild?.getAttribute('data-testid')).toBe('glyph')
    expect(agents.element().lastElementChild?.getAttribute('data-testid')).toBe('dot')
  })

  it('is one radio group with one tab stop, where the arrows, Home and End move and select at once', async () => {
    const screen = await render(<Modes />)
    const group = screen.getByRole('radiogroup', { name: '会话模式' })
    expect(tabStops(group.element())).toBe(1)
    await userEvent.tab()
    await expect.element(screen.getByRole('radio', { name: '对话' })).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    const agent = screen.getByRole('radio', { name: 'Agent' })
    await expect.element(agent).toHaveFocus()
    await expect.element(agent).toHaveAttribute('aria-checked', 'true')
    await userEvent.keyboard('{Home}')
    await expect.element(screen.getByRole('radio', { name: '对话' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.keyboard('{End}')
    await expect.element(agent).toHaveAttribute('aria-checked', 'true')
  })

  it('skips a segment that cannot be chosen', async () => {
    const screen = await render(<Modes third />)
    await userEvent.tab()
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(screen.getByRole('radio', { name: '计划' })).toHaveAttribute('aria-checked', 'true')
    press(screen.getByRole('radio', { name: 'Agent' }))
    await expect.element(screen.getByRole('radio', { name: 'Agent' })).toHaveAttribute('aria-checked', 'false')
  })

  it('raises the selected 24px segment on its own ringed face in a well, and never slides it', async () => {
    const screen = await render(<Modes />)
    const group = screen.getByRole('radiogroup').element()
    expect([style(group).boxShadow, style(group).backgroundColor, style(group).padding]).toEqual([
      'rgba(18, 18, 28, 0.043) 0px 0px 0px 1px inset, rgba(18, 18, 28, 0.05) 0px 1px 2px 0px inset',
      'rgb(243, 243, 246)',
      '2px',
    ])
    expect(group.querySelector('.ui-segmented-thumb')).toBeNull()
    const chosen = screen.getByRole('radio', { name: '对话' }).element()
    const other = screen.getByRole('radio', { name: 'Agent' }).element()
    expect([chosen.getBoundingClientRect().height, style(chosen).backgroundColor, style(chosen).color]).toEqual([
      24,
      'rgb(255, 255, 255)',
      'rgb(23, 23, 26)',
    ])
    expect(style(chosen).boxShadow).toMatch(/^rgba\(18, 18, 28, 0\.14\) 0px 0px 0px 1px inset, /u)
    expect([style(other).backgroundColor, style(other).color]).toEqual(['rgba(0, 0, 0, 0)', 'rgb(86, 86, 95)'])
    expect(style(chosen).transitionProperty).not.toMatch(/translate|transform|left/u)
  })
})

function Sections({ tabsDisabled = false }: { tabsDisabled?: boolean }) {
  const [tab, setTab] = useState<'args' | 'output'>('args')
  const [filter, setFilter] = useState<'all' | 'chat' | 'agent'>('all')
  return (
    <>
      <Tabs
        label="工具详情"
        value={tab}
        disabled={tabsDisabled}
        onValueChange={setTab}
        options={[
          { value: 'args', label: '参数', id: 'args-tab', controls: 'panel' },
          { value: 'output', label: '输出', id: 'output-tab', controls: 'panel' },
        ]}
      />
      <div role="tabpanel" id="panel" aria-labelledby={tab + '-tab'} />
      <FilterPills
        label="筛选会话"
        value={filter}
        onValueChange={setFilter}
        options={[
          { value: 'all', label: '全部' },
          { value: 'chat', label: '对话' },
          { value: 'agent', label: 'Agent' },
        ]}
      />
    </>
  )
}

describe('tabs and filter pills', () => {
  it('makes 24px tabs a tab list whose arrows select, the selected one on the hover fill, never sliding', async () => {
    const screen = await render(<Sections />)
    const list = screen.getByRole('tablist', { name: '工具详情' })
    expect(tabStops(list.element())).toBe(1)
    await userEvent.tab()
    await userEvent.keyboard('{ArrowRight}')
    const output = screen.getByRole('tab', { name: '输出' })
    await expect.element(output).toHaveAttribute('aria-selected', 'true')
    await expect.element(output).toHaveAttribute('aria-controls', 'panel')
    await expect.element(screen.getByRole('tabpanel', { name: '输出' })).toHaveAttribute('id', 'panel')
    await expect.element(output).toHaveFocus()
    const tab = output.element()
    expect(list.element().querySelector('.ui-tab-fill')).toBeNull()
    // Selection is neutral: never blue, never underlined; the others are muted.
    // The fill and the ink cross-fade in over --m-micro.
    const args = screen.getByRole('tab', { name: '参数' }).element()
    await expect
      .poll(() => [
        tab.getBoundingClientRect().height,
        style(tab).backgroundColor,
        style(tab).color,
        style(tab).borderTopLeftRadius,
        style(args).color,
      ])
      .toEqual([24, 'rgba(18, 18, 28, 0.05)', 'rgb(23, 23, 26)', '6px', 'rgb(86, 86, 95)'])
    expect(style(tab).textDecorationLine).toBe('none')
  })

  it('keeps a disabled tab list in the tab order and blocks keyboard and pointer selection', async () => {
    const screen = await render(<Sections tabsDisabled />)
    const args = screen.getByRole('tab', { name: '参数' })
    const output = screen.getByRole('tab', { name: '输出' })
    await userEvent.tab()
    await expect.element(args).toHaveFocus()
    await expect.element(output).toBeDisabled()
    await userEvent.keyboard('{ArrowRight}{End}')
    await expect.element(args).toHaveFocus()
    press(output)
    await expect.element(args).toHaveAttribute('aria-selected', 'true')
    await expect.element(output).toHaveAttribute('aria-selected', 'false')
  })

  it('makes filters pressed toggle buttons, not tabs, that share one tab stop', async () => {
    const screen = await render(<Sections />)
    const group = screen.getByRole('group', { name: '筛选会话' })
    expect(tabStops(group.element())).toBe(1)
    await expect.element(screen.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true')
    screen.getByRole('button', { name: 'Agent' }).element().focus()
    await userEvent.keyboard('{ArrowLeft}')
    await expect.element(screen.getByRole('button', { name: '对话' })).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('hints and reasons', () => {
  it('explains a switch, a segment, a disabled picker and the development mark in the themed tooltip, never a native title', async () => {
    const screen = await render(
      <div>
        <Switch label="验收模型插件" checked={false} disabled title="已由本机策略关闭" onCheckedChange={() => {}} />
        <SegmentedControl
          label="会话模式"
          value="agent"
          onValueChange={() => {}}
          options={[
            { value: 'chat', label: '对话', disabled: true, title: '此 Harness 不支持对话模式' },
            { value: 'agent', label: 'Agent', title: '可调用工具，需要时请你批准' },
          ]}
        />
        <ValuePicker
          label="模型"
          value="alpha"
          options={[
            { value: 'alpha', label: 'alpha-large' },
            { value: 'beta', label: 'beta-mini' },
          ]}
          disabled
          disabledReason="运行中不能切换"
          onValueChange={() => {}}
        />
        <DevMark description="开发模式：Host 代码可被本机修改" />
      </div>,
    )
    expect(screen.container.querySelectorAll('[title]')).toHaveLength(0)
    await expect.element(screen.getByRole('switch', { name: '验收模型插件' })).toHaveAccessibleDescription('已由本机策略关闭')
    await expect.element(screen.getByRole('radio', { name: '对话' })).toHaveAccessibleDescription('此 Harness 不支持对话模式')
    await expect.element(screen.getByRole('button', { name: '模型：alpha-large' })).toHaveAccessibleDescription('运行中不能切换')
    // The mark's name is already the sentence, so its tooltip shows on hover without describing it twice.
    const mark = screen.getByRole('note', { name: '开发模式：Host 代码可被本机修改' })
    expect(mark.element().hasAttribute('aria-describedby')).toBe(false)
    await userEvent.hover(mark)
    await expect
      .poll(() => Array.from(document.querySelectorAll('.ui-tooltip:popover-open'), tip => tip.textContent), { timeout: 2000 })
      .toEqual(['开发模式：Host 代码可被本机修改'])
  })
})

describe('choice controls', () => {
  const levels: Array<ChoiceOption<'L0' | 'L1' | 'L2' | 'L3'>> = [
    { value: 'L0', title: '只读', description: '不改文件，不运行命令', disabledReason: 'goose 无法保证此级别' },
    { value: 'L1', title: '逐项询问', description: '改文件、运行命令前先问你' },
    { value: 'L2', title: '自动编辑', description: '项目内直接编辑，命令仍会询问' },
    { value: 'L3', title: '完全访问', description: '不再询问，可以改动整台电脑', risk: true },
  ]
  function Levels() {
    const [level, setLevel] = useState<'L0' | 'L1' | 'L2' | 'L3'>('L1')
    return <ChoiceList label="在这台电脑上发起" value={level} onValueChange={setLevel} options={levels} />
  }

  it('makes a single-choice list one radio group where ↑/↓ select and skip what cannot be chosen', async () => {
    const screen = await render(<Levels />)
    const group = screen.getByRole('radiogroup', { name: '在这台电脑上发起' })
    expect(tabStops(group.element())).toBe(1)
    await userEvent.tab()
    await expect.element(screen.getByRole('radio', { name: '逐项询问' })).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    // 只读 cannot be chosen, so ↑ wraps past it to the last level.
    const full = screen.getByRole('radio', { name: '完全访问' })
    await expect.element(full).toHaveAttribute('aria-checked', 'true')
    // The risk mark follows the description only once that level is chosen.
    expect(full.element().querySelector('.ui-choice-risk')).not.toBeNull()
    expect(screen.getByRole('radio', { name: '自动编辑' }).element().querySelector('.ui-choice-risk')).toBeNull()
    const readOnly = screen.getByRole('radio', { name: '只读' })
    await expect.element(readOnly).toHaveAttribute('aria-disabled', 'true')
    await expect.element(readOnly).toHaveAccessibleDescription(/^不改文件，不运行命令\s*goose 无法保证此级别$/)
    press(readOnly)
    await expect.element(readOnly).toHaveAttribute('aria-checked', 'false')
    // The reason stays at full strength while the title dims.
    expect(style(readOnly.element().querySelector('.ui-choice-reason')!).opacity).toBe('1')
    expect(style(readOnly.element().querySelector('.ui-choice-title')!).opacity).toBe('0.45')
  })

  it("keeps each radio on its title's line, beside a description or a reason as on a title alone", async () => {
    const screen = await render(
      <ChoiceList label="发送消息" value="enter" onValueChange={() => {}} options={[{ value: 'enter', title: 'Enter 发送' }, ...levels]} />,
    )
    const offsets = Array.from(screen.container.querySelectorAll('.ui-choice'), row =>
      Math.abs(middle(row.querySelector('.ui-choice-radio')) - middle(row.querySelector('.ui-choice-title'))),
    )
    expect(offsets).toHaveLength(5)
    for (const offset of offsets) expect(offset).toBeLessThan(1)
    // A row with only a title stays centred in its 48px.
    const single = screen.getByRole('radio', { name: 'Enter 发送' }).element()
    expect(Math.abs(middle(single) - middle(single.querySelector('.ui-choice-title')))).toBeLessThan(1)
  })

  it('rings a chosen box or radio outside its accent fill, and an unchosen one inside its edge', async () => {
    const screen = await render(
      <div>
        <Checkbox aria-label="未选" />
        <Checkbox aria-label="已选" defaultChecked />
        <Radio aria-label="单选" defaultChecked />
      </div>,
    )
    const offsetOnTab = async (name: string, role: 'checkbox' | 'radio') => {
      await userEvent.tab()
      const element = screen.getByRole(role, { name }).element()
      expect(document.activeElement).toBe(element)
      expect(style(element).outlineColor).toBe('rgb(36, 97, 224)')
      return style(element).outlineOffset
    }
    expect(await offsetOnTab('未选', 'checkbox')).toBe('-2px')
    expect(await offsetOnTab('已选', 'checkbox')).toBe('2px')
    expect(await offsetOnTab('单选', 'radio')).toBe('2px')
  })

  it('draws a chosen option in the accent: the checked box and the radio ring', async () => {
    const screen = await render(
      <div>
        <Checkbox label="管理此 Host" description="模型服务、插件、项目和设备" />
      </div>,
    )
    const box = screen.getByRole('checkbox', { name: '管理此 Host' })
    // Unchecked: the raised surface inside a 1.5px line-strong ring.
    expect(style(box.element()).boxShadow).toBe('rgba(18, 18, 28, 0.14) 0px 0px 0px 1.5px inset')
    await userEvent.click(screen.getByText('管理此 Host'))
    await expect.element(box).toBeChecked()
    await expect.poll(() => style(box.element()).backgroundColor).toBe('rgb(36, 97, 224)')
  })
})
